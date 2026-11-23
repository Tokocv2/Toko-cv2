
const crypto = require("crypto");
const sendDigiflazz = require("../lib/digiflazz");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    MIDTRANS_SIGNATURE_SECRET
  } = process.env;

  try {
    if (
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY ||
      !MIDTRANS_SIGNATURE_SECRET
    ) {
      throw new Error("Environment variable belum lengkap");
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

    if (!order_id || !status_code || !gross_amount || !signature_key) {
      return res.status(400).json({
        message: "Data notifikasi tidak lengkap"
      });
    }

    // VERIFIKASI SIGNATURE MIDTRANS
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

    const baseUrl = `${SUPABASE_URL}/rest/v1/orders`;

    // AMBIL PESANAN
    const findResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&select=order_id,sku,customer_no,selling_price,payment_status,topup_status`,
      { headers }
    );

    const orders = await findResponse.json();

    if (!findResponse.ok || !orders.length) {
      return res.status(404).json({
        message: "Pesanan tidak ditemukan"
      });
    }

    const order = orders[0];

    if (Number(gross_amount) !== Number(order.selling_price)) {
      return res.status(400).json({
        message: "Nominal pembayaran tidak cocok"
      });
    }

    // TENTUKAN STATUS PEMBAYARAN
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

    // SIMPAN STATUS PEMBAYARAN
    const paymentUpdate = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}`,
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

    if (!paymentUpdate.ok) {
      throw new Error(await paymentUpdate.text());
    }

    // JANGAN KIRIM TOP-UP JIKA BELUM DIBAYAR
    if (paymentStatus !== "paid") {
      return res.status(200).json({
        message: "Status pembayaran diperbarui",
        order_id,
        payment_status: paymentStatus
      });
    }

    // KUNCI PESANAN SECARA ATOMIK
    const claimResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&payment_status=eq.paid&topup_status=eq.pending&select=order_id,sku,customer_no`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          topup_status: "processing"
        })
      }
    );

    const claimedOrders = await claimResponse.json();

    if (!claimResponse.ok) {
      throw new Error(JSON.stringify(claimedOrders));
    }

    // CEGAH PENGIRIMAN GANDA
    if (!claimedOrders.length) {
      return res.status(200).json({
        message: "Pesanan sudah diproses atau sedang diproses",
        order_id,
        payment_status: "paid"
      });
    }

    // KIRIM KE DIGIFLAZZ PRODUCTION
    let result;

    try {
      result = await sendDigiflazz(claimedOrders[0]);
    } catch (error) {
      console.error("Digiflazz Production error:", error);

      return res.status(200).json({
        message: "Pengiriman belum dapat dipastikan. Perlu pengecekan manual.",
        order_id,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    const digiflazzStatus = String(result.status || "").toLowerCase();

    let topupStatus = "processing";

    if (digiflazzStatus === "sukses") {
      topupStatus = "success";
    } else if (digiflazzStatus === "gagal") {
      topupStatus = "failed";
    }

    // SIMPAN HASIL TOP-UP
    const saveResult = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          topup_status: topupStatus
        })
      }
    );

    if (!saveResult.ok) {
      throw new Error(await saveResult.text());
    }

    return res.status(200).json({
      message: "Transaksi Digiflazz Production diproses",
      order_id,
      payment_status: "paid",
      topup_status: topupStatus,
      digiflazz_status: result.status
    });

  } catch (error) {
    console.error("Midtrans notification error:", error);

    return res.status(500).json({
      message: "Terjadi kesalahan pada server"
    });
  }
};
