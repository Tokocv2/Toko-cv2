import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
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

    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      totalSize += buffer.length;

      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();

        return res.status(413).json({
          success: false,
          message: "Ukuran request terlalu besar"
        });
      }

      chunks.push(buffer);
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

    // Verifikasi ping Digiflazz
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

    // Verifikasi signature transaksi
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

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Ref ID tidak ditemukan"
      });
    }

    let topupStatus = null;

    if (status === "sukses") {
      topupStatus = "success";
    } else if (status === "gagal") {
      topupStatus = "failed";
    }

    if (!topupStatus) {
      return res.status(200).json({
        success: true,
        message: "Status transaksi belum final"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        message: "Konfigurasi Supabase belum lengkap"
      });
    }

    // Hanya pesanan yang sudah dibayar dan belum final
    const url =
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/orders` +
      `?order_id=eq.${encodeURIComponent(orderId)}` +
      `&payment_status=eq.paid` +
      `&topup_status=in.(processing,pending,retrying)`;

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        topup_status: topupStatus
      })
    });

    const result = await response.text();

    if (!response.ok) {
      throw new Error(result);
    }

    const updatedRows = result ? JSON.parse(result) : [];

    console.log("DIGIFLAZZ_WEBHOOK_UPDATE:", {
      orderId,
      topupStatus,
      updatedRows: updatedRows.length
    });

    return res.status(200).json({
      success: true,
      message: updatedRows.length
        ? "Status top-up berhasil diperbarui"
        : "Tidak ada pesanan yang perlu diperbarui",
      order_id: orderId,
      topup_status: topupStatus,
      updated_rows: updatedRows.length
    });

  } catch (error) {
    console.error("DIGIFLAZZ_WEBHOOK_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal memproses webhook"
    });
  }
}

