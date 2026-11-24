
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_BODY_SIZE = 1024 * 1024;

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
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const secret = process.env.DIGIFLAZZ_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!secret || !supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        message: "Environment Variables belum lengkap"
      });
    }

    // BACA RAW BODY
    const contentLength = Number(
      req.headers["content-length"] || 0
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BODY_SIZE
    ) {
      return res.status(413).json({
        success: false,
        message: "Payload terlalu besar"
      });
    }

    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of req) {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_SIZE) {
        return res.status(413).json({
          success: false,
          message: "Payload terlalu besar"
        });
      }

      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks);

    if (!rawBody.length) {
      return res.status(400).json({
        success: false,
        message: "Body webhook kosong"
      });
    }

    // PARSING JSON
    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({
        success: false,
        message: "JSON tidak valid"
      });
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        success: false,
        message: "Format payload tidak valid"
      });
    }

    // VERIFIKASI PING DIGIFLAZZ
    if (
      payload.sed &&
      payload.hook_id &&
      payload.hook
    ) {
      const pingSecret = payload.hook.secret;

      if (
        typeof pingSecret !== "string" ||
        !safeEqual(pingSecret, secret)
      ) {
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

    // VERIFIKASI HMAC-SHA1
    const signature = req.headers["x-hub-signature"];

    if (
      typeof signature !== "string" ||
      !/^sha1=[a-f0-9]{40}$/i.test(signature)
    ) {
      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

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

    // VALIDASI DATA TRANSAKSI
    const data = payload.data;

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return res.status(400).json({
        success: false,
        message: "Data transaksi tidak valid"
      });
    }

    const orderId = data.ref_id;
    const customerNo = data.customer_no;
    const buyerSku = data.buyer_sku_code;
    const status = String(data.status || "")
      .trim()
      .toLowerCase();

    if (
      typeof orderId !== "string" ||
      !orderId.trim() ||
      typeof customerNo !== "string" ||
      !customerNo.trim() ||
      typeof buyerSku !== "string" ||
      !buyerSku.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Identitas transaksi tidak lengkap"
      });
    }

    const cleanOrderId = orderId.trim();
    const cleanCustomerNo = customerNo.trim();
    const cleanSku = buyerSku.trim();

    if (
      cleanOrderId.length > 100 ||
      cleanCustomerNo.length > 200 ||
      cleanSku.length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: "Identitas transaksi tidak valid"
      });
    }

    // STATUS FINAL DIGIFLAZZ
    let topupStatus;

    if (status === "sukses") {
      topupStatus = "success";
    } else if (status === "gagal") {
      topupStatus = "failed";
    } else {
      return res.status(200).json({
        success: true,
        message: "Status transaksi belum final",
        order_id: cleanOrderId
      });
    }

    const baseUrl =
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/orders`;

    const encodedOrderId =
      encodeURIComponent(cleanOrderId);

    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json"
    };

    // UPDATE ATOMIK:
    // - Pembayaran harus sudah paid.
    // - SKU dan nomor pelanggan harus cocok.
    // - Status lama harus pending, processing, atau retrying.
    // - Status final tidak dapat ditimpa.
    const updateUrl =
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      `&sku=eq.${encodeURIComponent(cleanSku)}` +
      `&customer_no=eq.${encodeURIComponent(cleanCustomerNo)}` +
      "&payment_status=eq.paid" +
      "&topup_status=in.(processing,pending,retrying)" +
      "&select=order_id,topup_status";

    const response = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        ...headers,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        topup_status: topupStatus
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      console.error(
        "DIGIFLAZZ_WEBHOOK_SUPABASE_ERROR:",
        await response.text()
      );

      throw new Error(
        "Gagal memperbarui status pesanan"
      );
    }

    const updatedRows = await response.json();

    if (!Array.isArray(updatedRows)) {
      throw new Error(
        "Respons Supabase tidak valid"
      );
    }

    console.log("DIGIFLAZZ_WEBHOOK_UPDATE:", {
      orderId: cleanOrderId,
      topupStatus,
      updatedRows: updatedRows.length
    });

    return res.status(200).json({
      success: true,
      message: updatedRows.length
        ? "Status top-up berhasil diperbarui"
        : "Pesanan tidak perlu diperbarui atau status sudah final",
      order_id: cleanOrderId,
      topup_status: topupStatus,
      updated_rows: updatedRows.length
    });

  } catch (error) {
    console.error(
      "DIGIFLAZZ_WEBHOOK_ERROR:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Gagal memproses webhook"
    });
  }
}
