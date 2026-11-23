import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks);
    const secret = process.env.DIGIFLAZZ_WEBHOOK_SECRET;

    if (!secret) {
      return res.status(500).json({
        success: false,
        message: "Webhook secret belum tersedia"
      });
    }

    const signature = req.headers["x-hub-signature"] || "";

    const expected =
      "sha1=" +
      crypto
        .createHmac("sha1", secret)
        .update(rawBody)
        .digest("hex");

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

    const payload = JSON.parse(rawBody.toString("utf8"));

    // Terima ping dari Digiflazz saat konfigurasi webhook
    if (payload.sed && payload.hook) {
      return res.status(200).json({
        success: true,
        message: "Webhook ping diterima"
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
        message: "Status belum final"
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

    const url =
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/orders` +
      `?order_id=eq.${encodeURIComponent(orderId)}` +
      `&topup_status=in.(processing,pending)`;

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

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return res.status(200).json({
      success: true,
      message: "Status top-up berhasil diperbarui",
      order_id: orderId,
      topup_status: topupStatus
    });

  } catch (error) {
    console.error("DIGIFLAZZ_WEBHOOK_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal memproses webhook"
    });
  }
}

