
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_BODY_SIZE = 1 * 1024 * 1024;

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
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
    }
  });
}

async function readOrder(orderId) {
  const query = new URLSearchParams({
    order_id: `eq.${orderId}`,
    select: [
      "order_id",
      "sku",
      "customer_no",
      "selling_price",
      "payment_status",
      "topup_status",
      "refund_status"
    ].join(","),
    limit: "1"
  });

  const response = await supabaseRequest(
    `orders?${query.toString()}`
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Gagal membaca pesanan: ${text}`);
  }

  const rows = text ? JSON.parse(text) : [];

  return rows[0] || null;
}

async function updateOrder(path, body) {
  const response = await supabaseRequest(path, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Gagal memperbarui pesanan: ${text}`);
  }

  return text ? JSON.parse(text) : [];
}

function createRefundKey(orderId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(orderId))
    .digest("hex")
    .slice(0, 32);

  return `TCV2-REF-${hash}`;
}

function getMidtransConfig() {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const mode = String(
    process.env.MIDTRANS_MODE || ""
  ).toLowerCase();

  if (!serverKey) {
    throw new Error("MIDTRANS_SERVER_KEY belum tersedia");
  }

  let baseUrl;

  if (mode === "production" || mode === "prod") {
    baseUrl = "https://api.midtrans.com";
  } else if (mode === "sandbox") {
    baseUrl = "https://api.sandbox.midtrans.com";
  } else {
    throw new Error("MIDTRANS_MODE tidak valid");
  }

  return {
    serverKey,
    baseUrl
  };
}

function getMidtransAuthorization(serverKey) {
  return (
    "Basic " +
    Buffer.from(`${serverKey}:`).toString("base64")
  );
}

// Memeriksa transaksi langsung ke Midtrans.
async function getMidtransTransactionStatus(orderId) {
  const { serverKey, baseUrl } = getMidtransConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/status`,
    {
      method: "GET",
      headers: {
        Authorization: getMidtransAuthorization(serverKey),
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const responseText = await response.text();

  let result;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error("Respons status Midtrans tidak valid");
  }

  if (!response.ok) {
    throw new Error(
      `Gagal memeriksa status Midtrans: ${responseText}`
    );
  }

  if (String(result.order_id) !== String(orderId)) {
    throw new Error("Order ID Midtrans tidak cocok");
  }

  return result;
}

// Meminta refund ke Midtrans.
async function requestMidtransRefund(
  orderId,
  amount,
  refundKey
) {
  const { serverKey, baseUrl } = getMidtransConfig();

  const response = await fetch(
    `${baseUrl}/v2/${encodeURIComponent(orderId)}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: getMidtransAuthorization(serverKey),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        refund_key: refundKey,
        amount,
        reason: "Top-up Digiflazz gagal"
      }),
      signal: AbortSignal.timeout(20000)
    }
  );

  const responseText = await response.text();

  let result;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = {
      raw_response: responseText
    };
  }

  if (!response.ok) {
    const error = new Error(
      `Midtrans menolak permintaan refund: ${responseText}`
    );

    error.refundRejected = true;

    throw error;
  }

  return result;
}

// Memproses refund hanya jika top-up benar-benar gagal
// dan transaksi pembayaran sudah settlement.
async function processFailedTopup(orderId) {
  const order = await readOrder(orderId);

  if (!order) {
    return {
      message: "Pesanan tidak ditemukan"
    };
  }

  if (order.payment_status !== "paid") {
    return {
      message: "Pesanan belum dibayar, refund tidak diproses"
    };
  }

  if (order.topup_status === "success") {
    return {
      message: "Top-up sudah sukses, refund tidak diproses"
    };
  }

  // Pastikan status top-up menjadi failed.
  if (
    ["processing", "pending", "retrying"].includes(
      order.topup_status
    )
  ) {
    const failedPath =
      `orders?order_id=eq.${encodeURIComponent(orderId)}` +
      "&payment_status=eq.paid" +
      "&topup_status=in.(processing,pending,retrying)";

    await updateOrder(failedPath, {
      topup_status: "failed"
    });
  }

  // Baca ulang status terbaru.
  const latestOrder = await readOrder(orderId);

  if (!latestOrder || latestOrder.topup_status !== "failed") {
    return {
      message: "Status pesanan berubah, refund tidak diproses"
    };
  }

  if (latestOrder.payment_status !== "paid") {
    return {
      message: "Status pembayaran tidak valid"
    };
  }

  if (latestOrder.refund_status !== "not_requested") {
    return {
      message: "Refund sudah diproses atau perlu pemeriksaan",
      refund_status: latestOrder.refund_status
    };
  }

  const amount = Number(latestOrder.selling_price);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Nominal refund tidak valid");
  }

  // VERIFIKASI PEMBAYARAN LANGSUNG KE MIDTRANS.
  const midtrans = await getMidtransTransactionStatus(orderId);

  const paidAmount = Number(midtrans.gross_amount);

  // Refund otomatis hanya boleh dilakukan jika:
  // 1. Status Midtrans settlement.
  // 2. Nominal pembayaran sama dengan harga pesanan.
  if (
    midtrans.transaction_status !== "settlement" ||
    !Number.isSafeInteger(paidAmount) ||
    paidAmount !== amount
  ) {
    const reviewPath =
      `orders?order_id=eq.${encodeURIComponent(orderId)}` +
      "&payment_status=eq.paid" +
      "&topup_status=eq.failed" +
      "&refund_status=eq.not_requested";

    await updateOrder(reviewPath, {
      refund_status: "needs_review"
    });

    console.error("REFUND_VALIDATION_FAILED:", {
      orderId,
      midtrans_status: midtrans.transaction_status,
      midtrans_amount: midtrans.gross_amount,
      order_amount: amount
    });

    return {
      message: "Pembayaran Midtrans belum memenuhi syarat refund otomatis",
      refund_status: "needs_review"
    };
  }

  const refundKey = createRefundKey(orderId);

  // Kunci refund secara atomik.
  // Hanya satu proses yang dapat mengambil kunci ini.
  const claimPath =
    `orders?order_id=eq.${encodeURIComponent(orderId)}` +
    "&payment_status=eq.paid" +
    "&topup_status=eq.failed" +
    "&refund_status=eq.not_requested";

  const claimedRows = await updateOrder(claimPath, {
    refund_status: "requesting",
    refund_key: refundKey,
    refund_amount: amount,
    refund_requested_at: new Date().toISOString()
  });

  if (!claimedRows.length) {
    return {
      message: "Refund sudah diklaim proses lain"
    };
  }

  try {
    const refundResult = await requestMidtransRefund(
      orderId,
      amount,
      refundKey
    );

    // Permintaan diterima bukan berarti uang sudah kembali.
    const requestedPath =
      `orders?order_id=eq.${encodeURIComponent(orderId)}` +
      `&refund_key=eq.${encodeURIComponent(refundKey)}` +
      "&refund_status=eq.requesting";

    await updateOrder(requestedPath, {
      refund_status: "requested"
    });

    console.log("MIDTRANS_REFUND_REQUESTED:", {
      orderId,
      amount,
      refundKey,
      response: refundResult
    });

    return {
      message: "Permintaan refund diterima Midtrans",
      refund_status: "requested",
      refund_amount: amount
    };

  } catch (error) {
    // Penolakan yang jelas harus diperiksa manual.
    if (error.refundRejected) {
      const reviewPath =
        `orders?order_id=eq.${encodeURIComponent(orderId)}` +
        `&refund_key=eq.${encodeURIComponent(refundKey)}` +
        "&refund_status=eq.requesting";

      await updateOrder(reviewPath, {
        refund_status: "needs_review"
      });

      console.error("MIDTRANS_REFUND_REJECTED:", {
        orderId,
        refundKey,
        error: error.message
      });

      return {
        message: "Refund ditolak Midtrans dan perlu pemeriksaan",
        refund_status: "needs_review"
      };
    }

    // Timeout atau hasil tidak pasti:
    // jangan kirim permintaan refund kedua secara otomatis.
    console.error("MIDTRANS_REFUND_UNCERTAIN:", {
      orderId,
      refundKey,
      error: error.message
    });

    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    // Batasi ukuran request.
    const contentLength = Number(req.headers["content-length"]);

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BODY_SIZE
    ) {
      return res.status(413).json({
        success: false,
        message: "Ukuran request terlalu besar"
      });
    }

    const chunks = [];
    let totalSize = 0;
    let tooLarge = false;

    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      if (tooLarge) continue;

      totalSize += buffer.length;

      if (totalSize > MAX_BODY_SIZE) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }

      chunks.push(buffer);
    }

    if (tooLarge) {
      return res.status(413).json({
        success: false,
        message: "Ukuran request terlalu besar"
      });
    }

    const rawBody = Buffer.concat(chunks, totalSize);

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({
        success: false,
        message: "JSON tidak valid"
      });
    }

    const secret = process.env.DIGIFLAZZ_WEBHOOK_SECRET;

    if (!secret) {
      return res.status(500).json({
        success: false,
        message: "Webhook secret belum tersedia"
      });
    }

    // Verifikasi ping Digiflazz.
    if (payload.sed && payload.hook_id && payload.hook) {
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

    // Verifikasi signature transaksi Digiflazz.
    const signature = req.headers["x-hub-signature"] || "";

    const expected =
      "sha1=" +
      crypto
        .createHmac("sha1", secret)
        .update(rawBody)
        .digest("hex");

    if (!safeEqual(signature, expected)) {
      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

    const data = payload.data || {};
    const orderId = data.ref_id;
    const status = String(data.status || "").toLowerCase();

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

    if (status !== "sukses" && status !== "gagal") {
      return res.status(200).json({
        success: true,
        message: "Status transaksi belum final"
      });
    }

    // Pastikan konfigurasi Supabase tersedia.
    getSupabaseConfig();

    // Status sukses.
    if (status === "sukses") {
      const successPath =
        `orders?order_id=eq.${encodeURIComponent(orderId)}` +
        "&payment_status=eq.paid" +
        "&topup_status=in.(processing,pending,retrying)";

      const updatedRows = await updateOrder(successPath, {
        topup_status: "success"
      });

      console.log("DIGIFLAZZ_WEBHOOK_SUCCESS:", {
        orderId,
        updatedRows: updatedRows.length
      });

      return res.status(200).json({
        success: true,
        message: updatedRows.length
          ? "Status top-up berhasil diperbarui"
          : "Tidak ada pesanan yang perlu diperbarui",
        order_id: orderId,
        topup_status: "success",
        updated_rows: updatedRows.length
      });
    }

    // Status gagal: jalankan pemeriksaan dan refund.
    const result = await processFailedTopup(orderId);

    console.log("DIGIFLAZZ_WEBHOOK_FAILED:", {
      orderId,
      result
    });

    return res.status(200).json({
      success: true,
      order_id: orderId,
      topup_status: "failed",
      ...result
    });

  } catch (error) {
    console.error("DIGIFLAZZ_WEBHOOK_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal memproses webhook"
    });
  }
}
      
