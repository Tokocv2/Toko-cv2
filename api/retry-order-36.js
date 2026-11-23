
const crypto = require("crypto");
const sendDigiflazz = require("../lib/digiflazz");

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    DIGIFLAZZ_RECOVERY_SECRET
  } = process.env;

  try {
    if (
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY ||
      !DIGIFLAZZ_RECOVERY_SECRET
    ) {
      throw new Error("Konfigurasi belum lengkap");
    }

    const suppliedSecret = req.headers["x-recovery-secret"] || "";

    if (!safeEqual(suppliedSecret, DIGIFLAZZ_RECOVERY_SECRET)) {
      return res.status(401).json({
        success: false,
        message: "Akses ditolak"
      });
    }

    const orderId =
      "TCV2-c308d729-b08d-4e14-ab65-042560f8cb05";

    const baseUrl =
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/orders`;

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    // Pastikan pesanan memang sudah dibayar
    const findResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(orderId)}&select=order_id,sku,customer_no,payment_status,topup_status`,
      { headers }
    );

    const orders = await findResponse.json();

    if (!findResponse.ok || !orders.length) {
      return res.status(404).json({
        success: false,
        message: "Order 36 tidak ditemukan"
      });
    }

    const order = orders[0];

    if (order.payment_status !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Pembayaran belum terkonfirmasi"
      });
    }

    // Kunci atomik: hanya satu permintaan boleh mengambil order
    const claimResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.paid&topup_status=eq.processing&select=order_id,sku,customer_no`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          topup_status: "retrying"
        })
      }
    );

    const claimed = await claimResponse.json();

    if (!claimResponse.ok) {
      throw new Error(JSON.stringify(claimed));
    }

    if (!claimed.length) {
      return res.status(409).json({
        success: false,
        message: "Order sudah dikunci, pernah dicoba, atau statusnya berubah"
      });
    }

    // Kirim ulang dengan ref_id order yang sama
    let result;

    try {
      result = await sendDigiflazz(claimed[0]);
    } catch (error) {
      console.error("Order 36 recovery error:", error);

      // Tetap retrying agar tidak terjadi pengiriman kedua
      return res.status(502).json({
        success: false,
        message: "Hasil pengiriman belum dapat dipastikan. Perlu pemeriksaan manual.",
        order_id: orderId,
        topup_status: "retrying"
      });
    }

    const status = String(result.status || "").toLowerCase();

    let finalStatus = null;

    if (status === "sukses") {
      finalStatus = "success";
    } else if (status === "gagal") {
      finalStatus = "failed";
    }

    // Status pending/tidak final tetap retrying.
    // Webhook akan memperbaruinya ketika hasil akhir diterima.

    if (finalStatus) {
      const saveResponse = await fetch(
        `${baseUrl}?order_id=eq.${encodeURIComponent(orderId)}&topup_status=eq.retrying`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            topup_status: finalStatus
          })
        }
      );

      const saved = await saveResponse.json();

      if (!saveResponse.ok) {
        throw new Error(JSON.stringify(saved));
      }

      return res.status(200).json({
        success: true,
        order_id: orderId,
        digiflazz_status: status,
        topup_status: saved.length
          ? finalStatus
          : "Sudah diperbarui webhook"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transaksi belum memiliki status akhir. Menunggu webhook.",
      order_id: orderId,
      digiflazz_status: status,
      topup_status: "retrying"
    });

  } catch (error) {
    console.error("Recovery endpoint error:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server"
    });
  }
};
      
