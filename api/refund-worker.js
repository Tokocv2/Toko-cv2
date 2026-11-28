
const crypto = require("node:crypto");

const BATCH_SIZE = 20;
const IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;
const MAX_REFUND_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const mode = String(process.env.MIDTRANS_MODE || "").toLowerCase();

  if (!supabaseUrl || !supabaseKey || !serverKey) {
    throw new Error("Konfigurasi Supabase atau Midtrans belum lengkap");
  }

  const baseUrl =
    mode === "production" || mode === "prod"
      ? "https://api.midtrans.com"
      : mode === "sandbox"
        ? "https://api.sandbox.midtrans.com"
        : null;

  if (!baseUrl) {
    throw new Error("MIDTRANS_MODE harus sandbox atau production");
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    supabaseKey,
    serverKey,
    baseUrl
  };
}

async function supabaseRequest(path, options = {}) {
  const config = getConfig();

  return fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    signal: options.signal || AbortSignal.timeout(15000)
  });
}

async function readEligibleOrders() {
  const query = new URLSearchParams({
    select:
      "order_id,selling_price,payment_status,topup_status,refund_status,refund_key,refund_amount,refund_requested_at",
    payment_status: "eq.paid",
    topup_status: "eq.failed",
    refund_status: "in.(not_requested,requesting,requested)",
    order: "created_at.asc",
    limit: String(BATCH_SIZE)
  });

  const response = await supabaseRequest(`orders?${query}`);
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Gagal mengambil pesanan: ${raw}`);
  }

  return raw ? JSON.parse(raw) : [];
}

async function patchOrder(orderId, filters, values) {
  const params = new URLSearchParams({
    order_id: `eq.${orderId}`,
    ...filters
  });

  const response = await supabaseRequest(`orders?${params}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify(values)
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Gagal memperbarui pesanan: ${raw}`);
  }

  return raw ? JSON.parse(raw) : [];
}

function makeRefundKey(orderId) {
  return `TCV2-REF-${crypto
    .createHash("sha256")
    .update(String(orderId))
    .digest("hex")
    .slice(0, 32)}`;
}

function midtransHeaders() {
  const { serverKey } = getConfig();

  return {
    Authorization:
      `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
    Accept: "application/json"
  };
}

async function midtransStatus(orderId) {
  const { baseUrl } = getConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/status`,
    {
      headers: midtransHeaders(),
      signal: AbortSignal.timeout(15000)
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Respons Status API Midtrans bukan JSON valid");
  }

  if (!response.ok) {
    throw new Error(
      `Midtrans status gagal (${response.status}): ${raw}`
    );
  }

  if (String(data.order_id) !== String(orderId)) {
    throw new Error("Order ID Midtrans tidak cocok");
  }

  return data;
}

async function sendRefund(orderId, amount, key) {
  const { baseUrl } = getConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/refund`,
    {
      method: "POST",
      headers: {
        ...midtransHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        refund_key: key,
        amount,
        reason: "Top-up Digiflazz gagal"
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Respons refund Midtrans bukan JSON valid");
  }

  if (!response.ok) {
    throw new Error(
      `Midtrans refund gagal (${response.status}): ${raw}`
    );
  }

  if (
    data.status_code &&
    !["200", "201", "202"].includes(String(data.status_code))
  ) {
    throw new Error(`Midtrans menolak refund: ${raw}`);
  }

  return data;
}

async function markReview(order, message) {
  await patchOrder(
    order.order_id,
    {
      refund_status: "neq.confirmed"
    },
    {
      refund_status: "needs_review"
    }
  );

  console.error("REFUND_WORKER_NEEDS_REVIEW:", {
    order_id: order.order_id,
    message
  });
}

async function reconcileRefund(order, status) {
  const key = order.refund_key || makeRefundKey(order.order_id);
  const amount = Number(order.refund_amount || order.selling_price);

  const refunds = Array.isArray(status.refunds)
    ? status.refunds
    : [];

  const found = refunds.find(item =>
    String(item.refund_key || "") === key &&
    Number(item.refund_amount) === amount
  );

  if (!found) {
    return false;
  }

  const confirmedAt = found.bank_confirmed_at
    ? new Date(found.bank_confirmed_at)
    : null;

  const confirmed =
    confirmedAt && !Number.isNaN(confirmedAt.getTime());

  await patchOrder(
    order.order_id,
    {
      refund_key: `eq.${key}`,
      refund_status: "in.(requesting,requested)"
    },
    confirmed
      ? {
          refund_status: "confirmed",
          refund_confirmed_at: confirmedAt.toISOString()
        }
      : {
          refund_status: "requested"
        }
  );

  return true;
}

function isTooOld(order) {
  if (!order.refund_requested_at) {
    return false;
  }

  const timestamp = new Date(
    order.refund_requested_at
  ).getTime();

  return Number.isFinite(timestamp) &&
    Date.now() - timestamp > MAX_REFUND_AGE_MS;
}

async function processOrder(order) {
  const orderId = String(order.order_id);
  const amount = Number(order.selling_price);
  const key = order.refund_key || makeRefundKey(orderId);

  if (
    order.payment_status !== "paid" ||
    order.topup_status !== "failed"
  ) {
    return "skipped";
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await markReview(order, "Nominal penjualan tidak valid");
    return "needs_review";
  }

  if (
    order.refund_amount != null &&
    Number(order.refund_amount) !== amount
  ) {
    await markReview(order, "Nominal refund tidak cocok");
    return "needs_review";
  }

  if (isTooOld(order)) {
    await markReview(order, "Batas percobaan ulang 7 hari telah lewat");
    return "needs_review";
  }

  if (
    order.refund_status === "requesting" &&
    order.refund_requested_at
  ) {
    const age =
      Date.now() -
      new Date(order.refund_requested_at).getTime();

    if (
      Number.isFinite(age) &&
      age >= 0 &&
      age < IN_FLIGHT_GRACE_MS
    ) {
      return "in_flight";
    }
  }

  // Periksa status pembayaran dan refund langsung ke Midtrans.
  const status = await midtransStatus(orderId);

  if (Number(status.gross_amount) !== amount) {
    await markReview(order, "Nominal pembayaran Midtrans tidak cocok");
    return "needs_review";
  }

  // Jika refund dengan key yang sama sudah ditemukan, rekonsiliasi.
  if (await reconcileRefund(order, status)) {
    return "reconciled";
  }

  // Refund lain yang tidak cocok dengan key toko harus diperiksa manual.
  if (
    Number(status.refund_amount || 0) > 0 ||
    String(status.transaction_status || "").toLowerCase() === "refund"
  ) {
    await markReview(
      order,
      "Refund ditemukan tetapi refund_key tidak cocok"
    );

    return "needs_review";
  }

  // Refund penuh hanya diproses dari transaksi settlement.
  if (
    String(status.transaction_status || "").toLowerCase() !==
    "settlement"
  ) {
    return "waiting_payment";
  }

  // PENGAMAN: refund tidak dikirim jika belum diaktifkan secara eksplisit.
  if (process.env.MIDTRANS_AUTO_REFUND !== "true") {
    return "auto_refund_disabled";
  }

  if (order.refund_status === "not_requested") {
    // Klaim atomik menggunakan kondisi refund_status.
    const claimed = await patchOrder(
      orderId,
      {
        payment_status: "eq.paid",
        topup_status: "eq.failed",
        refund_status: "eq.not_requested"
      },
      {
        refund_status: "requesting",
        refund_key: key,
        refund_amount: amount,
        refund_requested_at: new Date().toISOString()
      }
    );

    if (!claimed.length) {
      return "already_claimed";
    }
  } else if (
    !["requesting", "requested"].includes(order.refund_status)
  ) {
    return "skipped";
  }

  // Periksa lagi sebelum mengirim permintaan refund.
  const latestStatus = await midtransStatus(orderId);

  if (Number(latestStatus.gross_amount) !== amount) {
    await markReview(order, "Nominal berubah sebelum refund");
    return "needs_review";
  }

  if (await reconcileRefund(order, latestStatus)) {
    return "reconciled";
  }

  if (
    Number(latestStatus.refund_amount || 0) > 0 ||
    String(latestStatus.transaction_status || "").toLowerCase() !==
      "settlement"
  ) {
    await markReview(order, "Status transaksi berubah sebelum refund");
    return "needs_review";
  }

  try {
    await sendRefund(orderId, amount, key);
  } catch (error) {
    console.error("REFUND_WORKER_REQUEST_ERROR:", {
      order_id: orderId,
      message: error.message
    });

    // Jika respons tidak pasti, periksa Midtrans sebelum mencoba ulang.
    try {
      const afterError = await midtransStatus(orderId);

      if (await reconcileRefund(order, afterError)) {
        return "reconciled_after_error";
      }
    } catch (checkError) {
      console.error("REFUND_WORKER_RECHECK_ERROR:", {
        order_id: orderId,
        message: checkError.message
      });
    }

    return "request_uncertain";
  }

  const after = await midtransStatus(orderId);

  if (await reconcileRefund(order, after)) {
    return "refund_submitted";
  }

  return "refund_pending";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || "";

  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  try {
    const orders = await readEligibleOrders();

    const summary = {
      checked: orders.length,
      reconciled: 0,
      refund_submitted: 0,
      refund_pending: 0,
      auto_refund_disabled: 0,
      needs_review: 0,
      errors: 0,
      skipped: 0
    };

    for (const order of orders) {
      try {
        const result = await processOrder(order);

        if (
          result === "reconciled" ||
          result === "reconciled_after_error"
        ) {
          summary.reconciled++;
        } else if (result === "refund_submitted") {
          summary.refund_submitted++;
        } else if (result === "refund_pending") {
          summary.refund_pending++;
        } else if (result === "auto_refund_disabled") {
          summary.auto_refund_disabled++;
        } else if (result === "needs_review") {
          summary.needs_review++;
        } else {
          summary.skipped++;
        }
      } catch (error) {
        summary.errors++;

        console.error("REFUND_WORKER_ORDER_ERROR:", {
          order_id: order.order_id,
          message: error.message
        });
      }
    }

    console.log("REFUND_WORKER_COMPLETED:", summary);

    return res.status(200).json({
      success: true,
      message: "Refund worker selesai",
      ...summary
    });
  } catch (error) {
    console.error("REFUND_WORKER_FATAL:", error.message);

    return res.status(500).json({
      success: false,
      message: "Refund worker gagal dijalankan"
    });
  }
};
      
