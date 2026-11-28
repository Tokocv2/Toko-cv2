
const crypto = require("node:crypto");

const BATCH_SIZE = 20;
const IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;
const MAX_REFUND_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const mode = String(process.env.MIDTRANS_MODE || "").toLowerCase();

  if (!url || !key || !serverKey) {
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
    supabaseUrl: url.replace(/\/+$/, ""),
    supabaseKey: key,
    serverKey,
    baseUrl
  };
}

async function supabase(path, options = {}) {
  const c = config();

  return fetch(`${c.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: c.supabaseKey,
      Authorization: `Bearer ${c.supabaseKey}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    signal: AbortSignal.timeout(15000)
  });
}

async function readEligibleOrders() {
  const query = new URLSearchParams({
    select: "order_id,selling_price,payment_status,topup_status,refund_status,refund_key,refund_amount,refund_requested_at",
    payment_status: "eq.paid",
    topup_status: "eq.failed",
    refund_status: "in.(not_requested,requesting,requested)",
    order: "created_at.asc",
    limit: String(BATCH_SIZE)
  });

  const response = await supabase(`orders?${query}`);
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

  const response = await supabase(`orders?${params}`, {
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

function headers() {
  const c = config();

  return {
    Authorization: `Basic ${Buffer.from(`${c.serverKey}:`).toString("base64")}`,
    Accept: "application/json"
  };
}

async function midtransStatus(orderId) {
  const c = config();

  const response = await fetch(
    `${c.baseUrl}/v2/${encodeURIComponent(orderId)}/status`,
    {
      headers: headers(),
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
    throw new Error(`Midtrans status ${response.status}: ${raw}`);
  }

  if (String(data.order_id) !== String(orderId)) {
    throw new Error("Order ID dari Midtrans tidak cocok");
  }

  return data;
}

async function sendRefund(orderId, amount, key) {
  const c = config();

  const response = await fetch(
    `${c.baseUrl}/v2/${encodeURIComponent(orderId)}/refund`,
    {
      method: "POST",
      headers: {
        ...headers(),
        "Content-Type": "application/json",
        "Idempotency-Key": `refund-${key}`
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
    data = {};
  }

  if (!response.ok) {
    throw new Error(`Midtrans refund ${response.status}: ${raw}`);
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
    { refund_status: "neq.confirmed" },
    { refund_status: "needs_review" }
  );

  console.error("REFUND_WORKER_NEEDS_REVIEW:", {
    order_id: order.order_id,
    message
  });
}

async function reconcile(order, status) {
  const key = order.refund_key || makeRefundKey(order.order_id);
  const amount = Number(order.refund_amount || order.selling_price);

  const refunds = Array.isArray(status.refunds)
    ? status.refunds
    : [];

  const found = refunds.find(item =>
    String(item.refund_key || "") === key &&
    Number(item.refund_amount) === amount
  );

  if (!found) return false;

  const confirmed = Boolean(found.bank_confirmed_at);

  await patchOrder(
    order.order_id,
    {
      refund_key: `eq.${key}`,
      refund_status: "in.(requesting,requested)"
    },
    confirmed
      ? {
          refund_status: "confirmed",
          refund_confirmed_at: new Date(
            found.bank_confirmed_at
          ).toISOString()
        }
      : {
          refund_status: "requested"
        }
  );

  return true;
}

function isTooOld(order) {
  if (!order.refund_requested_at) return false;

  const time = new Date(order.refund_requested_at).getTime();

  return Number.isFinite(time) &&
    Date.now() - time > MAX_REFUND_AGE_MS;
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
    await markReview(order, "Melewati batas percobaan ulang 7 hari");
    return "needs_review";
  }

  // Hindari mengganggu proses refund yang baru diklaim endpoint lain.
  if (
    order.refund_status === "requesting" &&
    order.refund_requested_at
  ) {
    const age = Date.now() -
      new Date(order.refund_requested_at).getTime();

    if (Number.isFinite(age) && age < IN_FLIGHT_GRACE_MS) {
      return "in_flight";
    }
  }

  const status = await midtransStatus(orderId);

  if (Number(status.gross_amount) !== amount) {
    await markReview(order, "Nominal Midtrans tidak cocok");
    return "needs_review";
  }

  if (await reconcile(order, status)) {
    return "reconciled";
  }

  if (
    Number(status.refund_amount || 0) > 0 ||
    String(status.transaction_status).toLowerCase() === "refund"
  ) {
    await markReview(
      order,
      "Refund ditemukan tetapi refund_key tidak cocok"
    );

    return "needs_review";
  }

  if (
    !["settlement", "partial_refund"].includes(
      String(status.transaction_status || "").toLowerCase()
    )
  ) {
    return "waiting_payment";
  }

  // Pengaman utama: tidak ada refund tanpa pengaktifan eksplisit.
  if (process.env.MIDTRANS_AUTO_REFUND !== "true") {
    return "auto_refund_disabled";
  }

  if (order.refund_status === "not_requested") {
    // Klaim atomik: hanya satu proses yang boleh mengambil pesanan ini.
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

  // Periksa sekali lagi sebelum mengirim refund.
  const latestStatus = await midtransStatus(orderId);

  if (Number(latestStatus.gross_amount) !== amount) {
    await markReview(order, "Nominal berubah sebelum refund");
    return "needs_review";
  }

  if (await reconcile(order, latestStatus)) {
    return "reconciled";
  }

  if (
    Number(latestStatus.refund_amount || 0) > 0 ||
    !["settlement", "partial_refund"].includes(
      String(latestStatus.transaction_status || "").toLowerCase()
    )
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

    // Jangan membuat refund_key baru. Cek dahulu apakah Midtrans
    // sudah menerima permintaan sebelum percobaan berikutnya.
    try {
      const afterError = await midtransStatus(orderId);

      if (await reconcile(order, afterError)) {
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

  if (await reconcile(order, after)) {
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

        if (result === "reconciled" ||
            result === "reconciled_after_error") {
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
