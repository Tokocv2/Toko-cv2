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
  const serverKey = process.env.MIDTRANS_SERVER_KEY || process.env.MIDTRANS_SIGNATURE_SECRET;
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
    select: "order_id,sku,customer_no,selling_price,payment_status,topup_status,refund_status,refund_key,refund_amount,midtrans_transaction_id",
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

  if (!response.ok) throw new Error(`GET status Midtrans gagal (${response.status}): ${raw}`);
  if (String(data.order_id) !== String(orderId)) throw new Error("Order ID Midtrans tidak cocok");

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

  if (!response.ok) {
    const error = new Error(`Permintaan refund gagal (${response.status}): ${raw}`);
    error.httpStatus = response.status;
    throw error;
  }

  return data;
}

async function reconcileRefund(order, statusData) {
  const key = order.refund_key || refundKey(order.order_id);
  const amount = Number(order.refund_amount || order.selling_price);
  const refunds = Array.isArray(statusData.refunds) ? statusData.refunds : [];

  const found = refunds.find(r =>
    String(r.refund_key || "") === key &&
    Number(r.refund_amount) === amount
  );

  if (!found) return { found: false };

  const path =
    `orders?order_id=eq.${encodeURIComponent(order.order_id)}` +
    `&refund_key=eq.${encodeURIComponent(key)}` +
    "&refund_status=in.(requesting,requested)";

  if (found.bank_confirmed_at) {
    const date = new Date(found.bank_confirmed_at);

    await updateOrder(path, {
      refund_status: "confirmed",
      refund_confirmed_at: Number.isNaN(date.getTime())
        ? new Date().toISOString()
        : date.toISOString()
    });

    return { found: true, confirmed: true };
  }

  await updateOrder(path, { refund_status: "requested" });

  return { found: true, confirmed: false };
}

async function processRefund(orderId) {
  let order = await readOrder(orderId);

  if (!order) return;
  if (order.payment_status !== "paid" || order.topup_status !== "failed") return;
  if (order.refund_status === "confirmed" || order.refund_status === "needs_review") return;

  const amount = Number(order.selling_price);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Nominal refund tidak valid");
  }

  const payment = await midtransStatus(orderId);

  if (Number(payment.gross_amount) !== amount) {
    await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_status=neq.confirmed`,
      { refund_status: "needs_review" }
    );
    return;
  }

  if (!["settlement", "partial_refund", "refund"].includes(payment.transaction_status)) {
    return;
  }

  const key = order.refund_key || refundKey(orderId);
  const current = await reconcileRefund(order, payment);

  if (current.found) return;

  if (Number(payment.refund_amount || 0) > 0) {
    await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_status=neq.confirmed`,
      { refund_status: "needs_review" }
    );
    return;
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

    if (!claimed.length) return;

    order = {
      ...order,
      refund_status: "requesting",
      refund_key: key,
      refund_amount: amount
    };
  } else if (!["requesting", "requested"].includes(order.refund_status)) {
    return;
  }

  const beforeRetry = await midtransStatus(orderId);
  const beforeResult = await reconcileRefund(order, beforeRetry);

  if (beforeResult.found) return;

  if (
    Number(beforeRetry.gross_amount) !== amount ||
    !["settlement", "partial_refund"].includes(beforeRetry.transaction_status) ||
    Number(beforeRetry.refund_amount || 0) > 0
  ) {
    await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_key=eq.${encodeURIComponent(key)}&refund_status=in.(requesting,requested)`,
      { refund_status: "needs_review" }
    );
    return;
  }

  try {
    await postRefund(orderId, amount, key);
  } catch (error) {
    try {
      const afterError = await midtransStatus(orderId);
      const result = await reconcileRefund(order, afterError);

      if (result.found) return;
    } catch (reconcileError) {
      console.error("REFUND_RECONCILE_ERROR:", reconcileError.message);
    }

    console.error("MIDTRANS_REFUND_UNCERTAIN:", {
      orderId,
      key,
      error: error.message
    });

    return;
  }

  const after = await midtransStatus(orderId);
  const result = await reconcileRefund(order, after);

  if (!result.found) {
    await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_key=eq.${encodeURIComponent(key)}&refund_status=eq.requesting`,
      { refund_status: "requested" }
    );
  }
}

function isPaymentSuccessful(payload) {
  const status = String(payload.transaction_status || "").toLowerCase();
  const fraud = String(payload.fraud_status || "").toLowerCase();

  return (
    String(payload.status_code) === "200" &&
    (status === "settlement" || (status === "capture" && (!fraud || fraud === "accept")))
  );
}

async function handlePaymentNotification(payload) {
  const orderId = String(payload.order_id || "");

  if (!orderId || orderId.length > 200) {
    throw new Error("Order ID not valid");
  }

  const order = await readOrder(orderId);

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
  const successful = isPaymentSuccessful(payload);

  if (successful) {
    if (order.payment_status !== "paid") {
      const claimed = await updateOrder(
        `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.pending`,
        {
          payment_status: "paid",
          midtrans_transaction_id: payload.transaction_id || null
        }
      );

      if (!claimed.length) {
        const latest = await readOrder(orderId);

        if (!latest || latest.payment_status !== "paid") {
          return {
            ignored: true,
            reason: "Status pembayaran berubah; perlu pemeriksaan"
          };
        }
      }
    }

    const latest = await readOrder(orderId);

    if (!latest) {
      return { ignored: true, reason: "Pesanan tidak ditemukan" };
    }

    if (latest.topup_status === "pending") {
      const claimed = await updateOrder(
        `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.paid&topup_status=eq.pending`,
        { topup_status: "processing" }
      );

      if (claimed.length) {
        try {
          const result = await sendDigiflazz({
            order_id: orderId,
            sku: latest.sku,
            customer_no: latest.customer_no
          });

          const returnedRef = result.ref_id == null
            ? orderId
            : String(result.ref_id);

          if (
            returnedRef !== orderId ||
            String(result.buyer_sku_code || latest.sku) !== String(latest.sku) ||
            String(result.customer_no || latest.customer_no) !== String(latest.customer_no)
          ) {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "needs_review" }
            );

            return { processed: true, topup_status: "needs_review" };
          }

          const resultStatus = String(result.status || "").toLowerCase();

          if (resultStatus === "sukses") {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "success" }
            );
          } else if (resultStatus === "gagal") {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "failed" }
            );

            await processRefund(orderId);
          } else {
            await updateOrder(
              `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.processing`,
              { topup_status: "pending" }
            );
          }

          return { processed: true, topup_status: resultStatus };
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
      processed: false,
      message: "Pembayaran sudah tercatat atau top-up sedang diproses"
    };
  }

  if (status === "expire" || status === "cancel" || status === "deny") {
    if (order.payment_status !== "paid") {
      await updateOrder(
        `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.pending`,
        { payment_status: "failed" }
      );
    }

    return { processed: true, payment_status: status };
  }

  if (status === "refund" || status === "partial_refund") {
    await processRefund(orderId);
    return { processed: true, payment_status: status };
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

    const signature = crypto
      .createHash("sha512")
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
