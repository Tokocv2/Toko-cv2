import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_BODY_SIZE = 1 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Konfigurasi Supabase belum lengkap");
  }

  return {
    url: url.replace(/\/+$/, ""),
    key
  };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();

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

  if (!response.ok) {
    throw new Error(`Gagal membaca pesanan: ${body}`);
  }

  const rows = body ? JSON.parse(body) : [];
  return rows[0] || null;
}

async function updateOrder(path, values) {
  const response = await supabaseRequest(path, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify(values)
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Gagal memperbarui pesanan: ${body}`);
  }

  return body ? JSON.parse(body) : [];
}

function midtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const mode = String(process.env.MIDTRANS_MODE || "").toLowerCase();

  if (!serverKey) {
    throw new Error("MIDTRANS_SERVER_KEY belum tersedia");
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
    serverKey,
    baseUrl
  };
}

function refundKey(orderId) {
  return `TCV2-REF-${crypto
    .createHash("sha256")
    .update(String(orderId))
    .digest("hex")
    .slice(0, 32)}`;
}

function midtransHeaders(serverKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
    Accept: "application/json"
  };
}

async function midtransStatus(orderId) {
  const { serverKey, baseUrl } = midtransConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/status`,
    {
      headers: midtransHeaders(serverKey),
      signal: AbortSignal.timeout(15000)
    }
  );

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
  const { serverKey, baseUrl } = midtransConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/refund`,
    {
      method: "POST",
      headers: {
        ...midtransHeaders(serverKey),
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
    data = {
      raw_response: raw
    };
  }

  if (
    !response.ok ||
    (data.status_code &&
      !["200", "201"].includes(String(data.status_code)))
  ) {
    throw new Error(
      `Permintaan refund Midtrans gagal (${response.status}): ${raw}`
    );
  }

  return data;
}

function validDate(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

async function reconcileRefund(order, statusData) {
  const key = order.refund_key || refundKey(order.order_id);
  const expectedAmount = Number(
    order.refund_amount || order.selling_price
  );

  const refunds = Array.isArray(statusData.refunds)
    ? statusData.refunds
    : [];

  const match = refunds.find(item =>
    String(item.refund_key || "") === key &&
    Number(item.refund_amount) === expectedAmount
  );

  if (!match) {
    return {
      found: false,
      key,
      amount: expectedAmount
    };
  }

  const confirmedAt = validDate(match.bank_confirmed_at);

  const path =
    `orders?order_id=eq.${encodeURIComponent(order.order_id)}` +
    `&refund_key=eq.${encodeURIComponent(key)}` +
    "&refund_status=in.(requesting,requested)";

  await updateOrder(
    path,
    confirmedAt
      ? {
          refund_status: "confirmed",
          refund_confirmed_at: confirmedAt
        }
      : {
          refund_status: "requested"
        }
  );

  return {
    found: true,
    confirmed: Boolean(confirmedAt),
    key,
    amount: expectedAmount
  };
}

async function markRefundReview(orderId, key, message) {
  const keyFilter = key
    ? `&refund_key=eq.${encodeURIComponent(key)}`
    : "";

  await updateOrder(
    `orders?order_id=eq.${encodeURIComponent(orderId)}&refund_status=neq.confirmed${keyFilter}`,
    {
      refund_status: "needs_review"
    }
  );

  console.error("REFUND_NEEDS_REVIEW:", {
    orderId,
    message
  });
}

async function processFailedTopup(orderId) {
  let order = await readOrder(orderId);

  if (!order) {
    return {
      message: "Pesanan tidak ditemukan",
      refund_status: "not_found"
    };
  }

  if (
    order.payment_status !== "paid" ||
    order.topup_status !== "failed"
  ) {
    return {
      message: "Refund menunggu pembayaran paid dan top-up failed",
      refund_status: order.refund_status
    };
  }

  if (order.refund_status === "confirmed") {
    return {
      message: "Refund sudah dikonfirmasi bank",
      refund_status: "confirmed"
    };
  }

  if (order.refund_status === "needs_review") {
    return {
      message: "Refund perlu pemeriksaan manual",
      refund_status: "needs_review"
    };
  }

  const amount = Number(order.selling_price);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await markRefundReview(
      orderId,
      order.refund_key,
      "Nominal selling_price tidak valid"
    );

    return {
      message: "Nominal refund tidak valid",
      refund_status: "needs_review"
    };
  }

  const key = order.refund_key || refundKey(orderId);
  const payment = await midtransStatus(orderId);

  if (Number(payment.gross_amount) !== amount) {
    await markRefundReview(
      orderId,
      order.refund_key,
      "Nominal pembayaran Midtrans tidak cocok"
    );

    return {
      message: "Nominal pembayaran tidak cocok",
      refund_status: "needs_review"
    };
  }

  const current = await reconcileRefund(order, payment);

  if (current.found) {
    return {
      message: current.confirmed
        ? "Refund dikonfirmasi bank"
        : "Refund tercatat di Midtrans; menunggu konfirmasi bank",
      refund_status: current.confirmed
        ? "confirmed"
        : "requested"
    };
  }

  if (
    Number(payment.refund_amount || 0) > 0 ||
    payment.transaction_status === "refund"
  ) {
    await markRefundReview(
      orderId,
      order.refund_key,
      "Ada refund lain/tidak cocok pada transaksi"
    );

    return {
      message: "Ada refund lain pada transaksi; perlu pemeriksaan",
      refund_status: "needs_review"
    };
  }

  if (
    !["settlement", "partial_refund"].includes(
      String(payment.transaction_status || "").toLowerCase()
    )
  ) {
    return {
      message: "Pembayaran belum settlement; refund menunggu",
      refund_status: order.refund_status
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
      order = await readOrder(orderId);

      if (
        !order ||
        !["requesting", "requested"].includes(order.refund_status)
      ) {
        return {
          message: "Proses refund sedang ditangani proses lain",
          refund_status: order?.refund_status
        };
      }
    } else {
      order = {
        ...order,
        refund_status: "requesting",
        refund_key: key,
        refund_amount: amount,
        refund_requested_at: new Date().toISOString()
      };
    }
  } else if (
    !["requesting", "requested"].includes(order.refund_status)
  ) {
    return {
      message: "Status refund tidak dikenal; perlu pemeriksaan",
      refund_status: order.refund_status
    };
  }

  if (order.refund_requested_at) {
    const started = new Date(
      order.refund_requested_at
    ).getTime();

    if (
      Number.isFinite(started) &&
      Date.now() - started > 7 * 24 * 60 * 60 * 1000
    ) {
      await markRefundReview(
        orderId,
        key,
        "Jendela retry refund_key 7 hari telah lewat"
      );

      return {
        message: "Retry refund melewati batas 7 hari; perlu pemeriksaan manual",
        refund_status: "needs_review"
      };
    }
  }

  const latest = await midtransStatus(orderId);
  const latestMatch = await reconcileRefund(order, latest);

  if (latestMatch.found) {
    return {
      message: latestMatch.confirmed
        ? "Refund dikonfirmasi bank"
        : "Refund tercatat; menunggu konfirmasi bank",
      refund_status: latestMatch.confirmed
        ? "confirmed"
        : "requested"
    };
  }

  if (
    Number(latest.gross_amount) !== amount ||
    !["settlement", "partial_refund"].includes(
      String(latest.transaction_status || "").toLowerCase()
    ) ||
    Number(latest.refund_amount || 0) > 0
  ) {
    await markRefundReview(
      orderId,
      key,
      "Status pembayaran/refund berubah"
    );

    return {
      message: "Status pembayaran/refund berubah; perlu pemeriksaan",
      refund_status: "needs_review"
    };
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
          message: reconciled.confirmed
            ? "Refund dikonfirmasi bank"
            : "Refund tercatat; menunggu konfirmasi bank",
          refund_status: reconciled.confirmed
            ? "confirmed"
            : "requested"
        };
      }
    } catch (reconcileError) {
      console.error(
        "REFUND_RECONCILE_AFTER_ERROR:",
        reconcileError.message
      );
    }

    return {
      message: "Hasil permintaan refund belum pasti; akan direkonsiliasi memakai refund_key yang sama",
      refund_status: "requesting"
    };
  }

  const after = await midtransStatus(orderId);
  const reconciled = await reconcileRefund(order, after);

  if (reconciled.found) {
    return {
      message: reconciled.confirmed
        ? "Refund dikonfirmasi bank"
        : "Refund diterima; menunggu konfirmasi bank",
      refund_status: reconciled.confirmed
        ? "confirmed"
        : "requested"
    };
  }

  return {
    message: "Permintaan refund sudah dikirim; status menunggu rekonsiliasi Midtrans",
    refund_status: "requesting"
  };
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    size += buffer.length;

    if (size > MAX_BODY_SIZE) {
      const error = new Error("Ukuran request terlalu besar");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, size);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const contentLength = Number(
      req.headers["content-length"]
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BODY_SIZE
    ) {
      return res.status(413).json({
        success: false,
        message: "Ukuran request terlalu besar"
      });
    }

    const raw = await readRawBody(req);

    let payload;

    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({
        success: false,
        message: "JSON tidak valid"
      });
    }

    const secret = process.env.DIGIFLAZZ_WEBHOOK_SECRET;

    if (!secret) {
      throw new Error("DIGIFLAZZ_WEBHOOK_SECRET belum tersedia");
    }

    if (payload?.sed && payload?.hook_id && payload?.hook) {
      if (!safeEqual(payload.hook.secret || "", secret)) {
        return res.status(401).json({
          success: false,
          message: "Ping secret tidak valid"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Webhook ping diterima"
      });
    }

    const signature = req.headers["x-hub-signature"] || "";

    const expected =
      "sha1=" +
      crypto
        .createHmac("sha1", secret)
        .update(raw)
        .digest("hex");

    if (!safeEqual(signature, expected)) {
      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

    const data = payload?.data || {};
    const orderId = data.ref_id;
    const status = String(data.status || "")
      .trim()
      .toLowerCase();

    if (
      typeof orderId !== "string" ||
      !orderId.trim() ||
      orderId.length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: "Ref ID tidak valid"
      });
    }

    if (!["sukses", "gagal"].includes(status)) {
      return res.status(200).json({
        success: true,
        message: "Status transaksi belum final"
      });
    }

    const order = await readOrder(orderId);

    if (!order) {
      return res.status(200).json({
        success: true,
        message: "Pesanan tidak ditemukan; diabaikan"
      });
    }

    if (
      String(data.buyer_sku_code || "") !== String(order.sku || "") ||
      String(data.customer_no || "") !== String(order.customer_no || "")
    ) {
      console.error("DIGIFLAZZ_WEBHOOK_ORDER_MISMATCH:", {
        orderId
      });

      return res.status(200).json({
        success: true,
        message: "Data webhook tidak cocok dengan pesanan; diabaikan"
      });
    }

    if (status === "sukses") {
      const rows = await updateOrder(
        `orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.paid&topup_status=in.(processing,pending,retrying)`,
        {
          topup_status: "success"
        }
      );

      return res.status(200).json({
        success: true,
        message: rows.length
          ? "Top-up berhasil diperbarui"
          : "Tidak ada perubahan status",
        order_id: orderId,
        updated_rows: rows.length
      });
    }

    const failedRows = await updateOrder(
      `orders?order_id=eq.${encodeURIComponent(orderId)}&topup_status=in.(processing,pending,retrying)`,
      {
        topup_status: "failed"
      }
    );

    const latest = await readOrder(orderId);

    if (!latest) {
      return res.status(200).json({
        success: true,
        message: "Pesanan tidak ditemukan"
      });
    }

    if (latest.topup_status === "success") {
      return res.status(200).json({
        success: true,
        message: "Top-up sudah sukses; webhook gagal diabaikan",
        order_id: orderId
      });
    }

    if (latest.topup_status !== "failed") {
      return res.status(200).json({
        success: true,
        message: "Status top-up tidak dapat diubah; perlu pemeriksaan",
        order_id: orderId
      });
    }

    const refund = latest.payment_status === "paid"
      ? await processFailedTopup(orderId)
      : {
          message: "Kegagalan top-up tersimpan; refund menunggu pembayaran paid",
          refund_status: latest.refund_status
        };

    return res.status(200).json({
      success: true,
      order_id: orderId,
      topup_status: "failed",
      updated_rows: failedRows.length,
      ...refund
    });

  } catch (error) {
    console.error("DIGIFLAZZ_WEBHOOK_ERROR:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode === 413
        ? "Ukuran request terlalu besar"
        : "Gagal memproses webhook"
    });
  }
}
