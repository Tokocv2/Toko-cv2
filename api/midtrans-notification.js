
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      MIDTRANS_SIGNATURE_SECRET
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !MIDTRANS_SIGNATURE_SECRET) {
      return res.status(500).json({
        message: "Environment variable belum lengkap"
      });
    }

    const body = req.body || {};
    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status,
      fraud_status
    } = body;

    if (
      !order_id ||
      !status_code ||
      !gross_amount ||
      !signature_key
    ) {
      return res.status(400).json({
        message: "Data notifikasi tidak lengkap"
      });
    }

    // Verifikasi tanda tangan notifikasi Midtrans
    const signature = crypto
      .createHash("sha512")
      .update(
        order_id +
        status_code +
        gross_amount +
        MIDTRANS_SIGNATURE_SECRET
      )
      .digest("hex");

    const received = Buffer.from(signature_key, "hex");
    const expected = Buffer.from(signature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.status(401).json({
        message: "Signature tidak valid"
      });
    }

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    // Cari pesanan berdasarkan order_id
    const findResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(order_id)}&select=order_id,selling_price`,
      { headers }
    );

    const orders = await findResponse.json();

    if (!findResponse.ok || !orders.length) {
      return res.status(404).json({
        message: "Pesanan tidak ditemukan"
      });
    }

    const order = orders[0];

    // Pastikan nominal pembayaran sesuai
    if (Number(gross_amount) !== Number(order.selling_price)) {
      return res.status(400).json({
        message: "Nominal pembayaran tidak cocok"
      });
    }

    let paymentStatus = "pending";

    if (
      transaction_status === "settlement" ||
      (
        transaction_status === "capture" &&
        fraud_status === "accept"
      )
    ) {
      paymentStatus = "paid";
    } else if (transaction_status === "expire") {
      paymentStatus = "expired";
    } else if (
      transaction_status === "cancel" ||
      transaction_status === "deny"
    ) {
      paymentStatus = "failed";
    }

    // Perbarui status pembayaran.
    // topup_status sengaja tidak diubah pada tahap testing ini.
    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(order_id)}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          payment_status: paymentStatus
        })
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      throw new Error(error);
    }

    return res.status(200).json({
      message: "Notifikasi berhasil diproses",
      order_id,
      payment_status: paymentStatus,
      topup_status: "pending"
    });

  } catch (error) {
    console.error("Midtrans notification error:", error);

    return res.status(500).json({
      message: "Terjadi kesalahan pada server"
    });
  }
};
      
