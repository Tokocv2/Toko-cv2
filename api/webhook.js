
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Midtrans belum lengkap"
    });
  }

  const {
    order_id,
    status_code,
    gross_amount,
    signature_key,
    transaction_status,
    fraud_status
  } = req.body || {};

  if (
    !order_id ||
    !status_code ||
    !gross_amount ||
    !signature_key
  ) {
    return res.status(400).json({
      success: false,
      message: "Notifikasi tidak lengkap"
    });
  }

  const expectedSignature = crypto
    .createHash("sha512")
    .update(
      order_id +
      status_code +
      gross_amount +
      serverKey
    )
    .digest("hex");

  const received = Buffer.from(signature_key);
  const expected = Buffer.from(expectedSignature);

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({
      success: false,
      message: "Signature tidak valid"
    });
  }

  const paid =
    transaction_status === "settlement" ||
    (
      transaction_status === "capture" &&
      fraud_status === "accept"
    );

  if (!paid) {
    return res.status(200).json({
      success: true,
      message: "Pembayaran belum berhasil",
      transaction_status
    });
  }

  // Belum menjalankan Digiflazz.
  // Pesanan harus dicocokkan dengan data pesanan
  // yang tersimpan di database terlebih dahulu.

  return res.status(200).json({
    success: true,
    verified: true,
    order_id,
    message: "Pembayaran terverifikasi, menunggu pemrosesan pesanan"
  });
}
  
