const crypto = require("node:crypto");
const sendDigiflazz = require("../lib/digiflazz");

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const mode = String(process.env.MIDTRANS_MODE || "").toLowerCase();

  if (!url || !key) throw new Error("Konfigurasi Supabase belum lengkap");
  if (!serverKey) throw new Error("MIDTRANS_SERVER_KEY belum tersedia");

  const baseUrl = mode === "production" || mode === "prod"
    ? "https://api.midtrans.com"
    : mode === "sandbox"
      ? "https://api.sandbox.midtrans.com"
      : null;

  if (!baseUrl) throw new Error("MIDTRANS_MODE harus sandbox atau production");
  return { url: url.replace(/\/+$/, ""), key, serverKey, baseUrl };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getConfig();
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    signal: options.signal || AbortSignal.timeout(15000)
  });
}

async function readOrder(orderId) {
  const query = new URLSearchParams({
    order_id: `eq.${orderId}`,
    select: "order_id,sku,customer_no,selling_price,payment_status,topup_status,refund_status,refund_key,refund_amount,refund_requested_at,midtrans_transaction_id",
    limit: "1"
  });

  const response = await supabaseRequest(`orders?${query}`);
  const body = await response.text();

  if (!response.ok) throw new Error(`Gagal membaca pesanan: ${body}`);

  const rows = body ? JSON.parse(body) : [];
  return rows[0] || null;
}

async function updateOrder(path, values) {
  const response = await supabaseRequest(path, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values)
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`Gagal memperbarui pesanan: ${body}`);

  return body ? JSON.parse(body) : [];
}

function refundKey(orderId) {
  return `TCV2-REF-${crypto.createHash("sha256").update(String(orderId)).digest("hex").slice(0, 32)}`;
}

function authHeaders(serverKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
    Accept: "application/json"
  };
}

async function midtransStatus(orderId) {
  const { serverKey, baseUrl } = getConfig();

  const response = await fetch(`${baseUrl}/v2/${encodeURIComponent(orderId)}/status`, {
    headers: authHeaders(serverKey),
    signal: AbortSignal.timeout(15000)
  });

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Respons status Midtrans tidak valid");
  }

  if (!response.ok) {
    throw new Error(`GET status Midtrans gagal (${response.status}): ${raw}`);
  }

  if (String(data.order_id) !== String(orderId)) {
    throw new Error("Order ID Midtrans tidak cocok");
  }

  return data;
}

async function postRefund(orderId, amount, key) {
  const { serverKey, baseUrl } = getConfig();

  const response = await fetch(`${baseUrl}/v2/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: {
      ...authHeaders(serverKey),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      refund_key: key,
      amount,
      reason: "Top-up Digiflazz gagal"
    }),
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw_response: raw };
  }

  if (!response.ok || (data.status_code && !["200", "201"].includes(String(data.status_code)))) {
    const error = new Error(`Permintaan refund Midtrans gagal (${response.status}): ${raw}`);
    error.httpStatus = response.status;
    error.responseData = data;
    throw error;
  }

  return data;
}

function validDate(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function reconcileRefund(order, statusData) {
  const key = order.refund_key || refundKey(order.order_id);
  const expectedAmount = Number(order.refund_amount || order.selling_price);
  const refunds = Array.isArray(statusData.refunds) ? statusData.refunds : [];

  const match = refunds.find(item =>
    String(item.refund_key || "") === key &&
    Number(item.refund_amount) === expectedAmount
  );

  if (!match) return { found: false, key, amount: expectedAmount };

  const confirmedAt = validDate(match.bank_confirmed_at);

  const path =
    `orders?order_id=eq.${encodeURIComponent(order.order_id)}` +
    `&refund_key=eq.${encodeURIComponent(key)}` +
    "&refund_status=in.(requesting,requested)";

  await updateOrder(path, confirmedAt
    ? { refund_status: "confirmed", refund_confirmed_at: confirmedAt }
    : { refund_status: "requested" });

  return {
    found: true,
    confirmed: Boolean(confirmedAt),
    key,
    amount: expectedAmount
  };
}

async function markRefundReview(orderId, key, message) {
  const keyFilter = key ? `&refund_key=eq.${encodeURIComponent(key)}` : "";

  await updateOrder(
    `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_status=neq.confirmed${keyFilter}`,
    { refund_status: "needs_review" }
  );

  console.error("REFUND_NEEDS_REVIEW:", { orderId, message });
}

async function processRefund(orderId) {
  let order = await readOrder(orderId);

  if (!order) return { refund_status: "not_found" };

  if (order.payment_status !== "paid" || order.topup_status !== "failed") {
    return {
      refund_status: order.refund_status,
      message: "Refund menunggu pembayaran paid dan top-up failed"
    };
  }

  if (order.refund_status === "confirmed") {
    return { refund_status: "confirmed" };
  }

  if (order.refund_status === "needs_review") {
    return { refund_status: "needs_review" };
  }

  const amount = Number(order.selling_price);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await markRefundReview(orderId, order.refund_key, "Nominal selling_price tidak valid");
    return { refund_status: "needs_review" };
  }

  const key = order.refund_key || refundKey(orderId);
  const payment = await midtransStatus(orderId);

  if (Number(payment.gross_amount) !== amount) {
    await markRefundReview(orderId, order.refund_key, "Nominal pembayaran Midtrans tidak cocok");
    return { refund_status: "needs_review" };
  }

  const existing = await reconcileRefund(order, payment);

  if (existing.found) {
    return {
      refund_status: existing.confirmed ? "confirmed" : "requested"
    };
  }

  if (Number(payment.refund_amount || 0) > 0 || payment.transaction_status === "refund") {
    await markRefundReview(
      orderId,
      order.refund_key,
      "Ada refund pada transaksi tetapi refund_key toko tidak ditemukan"
    );

    return { refund_status: "needs_review" };
  }

  if (!["settlement", "partial_refund"].includes(String(payment.transaction_status || "").toLowerCase())) {
    return {
      refund_status: order.refund_status,
      message: "Pembayaran belum settlement; refund menunggu"
    };
  }

  if (order.refund_status === "not_requested") {
    const claimed = await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.paid&topup_status=eq.failed&refund_status=eq.not_requested`,
      {
        refund_status: "requesting",
        refund_key: key,
        refund_amount: amount,
        refund_requested_at: new Date().toISOString(),
        midtrans_transaction_id: payment.transaction_id || null
      }
    );

    if (!claimed.length) {
      const latest = await readOrder(orderId);

      if (!latest || latest.refund_status === "confirmed" || latest.refund_status === "needs_review") {
        return { refund_status: latest?.refund_status || "unknown" };
      }

      order = latest;
    } else {
      order = {
        ...order,
        refund_status: "requesting",
        refund_key: key,
        refund_amount: amount,
        refund_requested_at: new Date().toISOString()
      };
    }
  } else if (!["requesting", "requested"].includes(order.refund_status)) {
    return { refund_status: order.refund_status || "unknown" };
  }

  if (order.refund_requested_at) {
    const requestedAt = new Date(order.refund_requested_at).getTime();

    if (Number.isFinite(requestedAt) && Date.now() - requestedAt > 7 * 24 * 60 * 60 * 1000) {
      await markRefundReview(orderId, key, "Jendela retry refund_key 7 hari telah lewat");
      return { refund_status: "needs_review" };
    }
  }

  const latestPayment = await midtransStatus(orderId);
  const latestFound = await reconcileRefund(order, latestPayment);

  if (latestFound.found) {
    return {
      refund_status: latestFound.confirmed ? "confirmed" : "requested"
    };
  }

  if (
    Number(latestPayment.gross_amount) !== amount ||
    !["settlement", "partial_refund"].includes(String(latestPayment.transaction_status || "").toLowerCase()) ||
    Number(latestPayment.refund_amount || 0) > 0
  ) {
    await markRefundReview(orderId, key, "Status pembayaran/refund berubah saat rekonsiliasi");
    return { refund_status: "needs_review" };
  }

  try {
    await postRefund(orderId, amount, key);
  } catch (error) {
    console.error("MIDTRANS_REFUND_REQUEST_UNCERTAIN:", {
      orderId,
      key,
      error: error.message
    });

    try {
      const afterError = await midtransStatus(orderId);
      const reconciled = await reconcileRefund(order, afterError);

      if (reconciled.found) {
        return {
          refund_status: reconciled.confirmed ? "confirmed" : "requested"
        };
      }
    } catch (reconcileError) {
      console.error("REFUND_RECONCILE_AFTER_ERROR:", reconcileError.message);
    }

    return { refund_status: "requesting", uncertain: true };
  }

  const after = await midtransStatus(orderId);
  const reconciled = await reconcileRefund(order, after);

  if (reconciled.found) {
    return {
      refund_status: reconciled.confirmed ? "confirmed" : "requested"
    };
  }

  return {
    refund_status: "requesting",
    pending_reconciliation: true
  };
}

function isPaymentSuccessful(payload) {
  const status = String(payload.transaction_status || "").toLowerCase();
  const fraud = String(payload.fraud_status || "").toLowerCase();

  return String(payload.status_code) === "200" &&
    (
      status === "settlement" ||
      (status === "capture" && (!fraud || fraud === "accept"))
    );
}

async function setPaymentPaid(orderId, transactionId) {
  await updateOrder(
    `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=in.(pending,failed)`,
    {
      payment_status: "paid",
      midtrans_transaction_id: transactionId || null
    }
  );

  return await readOrder(orderId);
}

async function handlePaymentNotification(payload) {
  const orderId = String(payload.order_id || "");

  if (!orderId || orderId.length > 200) {
    throw new Error("Order ID tidak valid");
  }

  let order = await readOrder(orderId);

  if (!order) {
    return { ignored: true, reason: "Pesanan tidak ditemukan" };
  }

  const gross = Number(payload.gross_amount);
  const sellingPrice = Number(order.selling_price);

  if (!Number.isSafeInteger(sellingPrice) || gross !== sellingPrice) {
    console.error("MIDTRANS_AMOUNT_MISMATCH:", {
      orderId,
      gross,
      sellingPrice
    });

    return { ignored: true, reason: "Nominal pembayaran tidak cocok" };
  }

  const status = String(payload.transaction_status || "").toLowerCase();

  if (isPaymentSuccessful(payload)) {
    order = await setPaymentPaid(orderId, payload.transaction_id);

    if (!order) {
      return { ignored: true, reason: "Pesanan tidak ditemukan" };
    }

    if (order.topup_status === "failed") {
      const refund = await processRefund(orderId);

      return {
        processed: true,
        payment_status: "paid",
        topup_status: "failed",
        ...refund
      };
    }

    if (order.topup_status === "pending") {
      const claimed = await updateOrder(
        `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.paid&topup_status=eq.pending`,
        { topup_status: "processing" }
      );

      if (claimed.length) {
        try {
          const result = await sendDigiflazz({
            order_id: orderId,
            sku: order.sku,
            customer_no: order.customer_no
          });

          const returnedRef = result.ref_id == null
            ? orderId
            : String(result.ref_id);

          if (
            returnedRef !== orderId ||
            String(result.buyer_sku_code || order.sku) !== String(order.sku) ||
            String(result.customer_no || order.customer_no) !== String(order.customer_no)
          ) {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "needs_review" }
            );

            return { processed: true, topup_status: "needs_review" };
          }

          const resultStatus = String(result.status || "").trim().toLowerCase();

          if (resultStatus === "sukses") {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "success" }
            );

            return { processed: true, topup_status: "success" };
          }

          if (resultStatus === "gagal") {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "failed" }
            );

            const refund = await processRefund(orderId);

            return {
              processed: true,
              topup_status: "failed",
              ...refund
            };
          }

          return {
            processed: true,
            topup_status: "processing",
            waiting_for_digiflazz_webhook: true
          };
        } catch (error) {
          console.error("DIGIFLAZZ_RESULT_UNCERTAIN:", {
            orderId,
            error: error.message
          });

          return {
            processed: true,
            topup_status: "processing",
            uncertain: true
          };
        }
      }
    }

    return {
      processed: true,
      payment_status: "paid",
      topup_status: order.topup_status,
      message: "Pembayaran tercatat; top-up sudah diproses atau sedang menunggu hasil Digiflazz"
    };
  }

  if (["expire", "cancel", "deny"].includes(status)) {
    await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.pending`,
      { payment_status: "failed" }
    );

    return { processed: true, payment_status: status };
  }

  if (status === "refund" || status === "partial_refund") {
    if (order.topup_status === "failed" && order.payment_status !== "paid") {
      await setPaymentPaid(orderId, payload.transaction_id);
    }

    const refund = await processRefund(orderId);

    return {
      processed: true,
      payment_status: status,
      ...refund
    };
  }

  return {
    processed: true,
    payment_status: status || "unknown"
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const payload = req.body && typeof req.body === "object"
      ? req.body
      : {};

    const { serverKey } = getConfig();
    const orderId = String(payload.order_id || "");
    const statusCode = String(payload.status_code || "");
    const grossAmount = String(payload.gross_amount || "");

    const signature = crypto.createHash("sha512")
      .update(orderId + statusCode + grossAmount + serverKey)
      .digest("hex");

    if (!orderId || !safeEqual(signature, payload.signature_key || "")) {
      return res.status(401).json({
        success: false,
        message: "Signature Midtrans tidak valid"
      });
    }

    const result = await handlePaymentNotification(payload);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error("MIDTRANS_NOTIFICATION_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal memproses notifikasi Midtrans"
    });
  }
};
