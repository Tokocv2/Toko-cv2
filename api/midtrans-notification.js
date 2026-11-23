
const crypto = require("crypto");
const sendDigiflazz = require("../lib/digiflazz");

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

    if (
      !order_id ||
      !status_code ||
      !gross_amount ||
      !signature_key
    ) {
      return res.status(400).json({
        success: false,
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
        success: false,
        message: "Signature tidak valid"
      });
    }

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    const baseUrl =
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/orders`;

    // CARI PESANAN
    const findResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&select=order_id,sku,customer_no,selling_price,payment_status,topup_status`,
      { headers }
    );

    if (!findResponse.ok) {
      throw new Error(await findResponse.text());
    }

    const orders = await findResponse.json();

    if (!orders.length) {
      return res.status(404).json({
        success: false,
        message: "Pesanan tidak ditemukan"
      });
    }

    const order = orders[0];

    // VALIDASI NOMINAL
    if (
      !Number.isFinite(Number(gross_amount)) ||
      Number(gross_amount) !== Number(order.selling_price)
    ) {
      return res.status(400).json({
        success: false,
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

    // PEMBAYARAN BELUM BERHASIL
    if (paymentStatus !== "paid") {
      // Jangan pernah menimpa pembayaran yang sudah paid.
      if (order.payment_status === "paid") {
        return res.status(200).json({
          success: true,
          message: "Pembayaran sudah tercatat berhasil",
          order_id,
          payment_status: "paid",
          topup_status: order.topup_status
        });
      }

      const update = await fetch(
        `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&payment_status=eq.pending`,
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

      if (!update.ok) {
        throw new Error(await update.text());
      }

      return res.status(200).json({
        success: true,
        order_id,
        payment_status: paymentStatus
      });
    }

    // CATAT PEMBAYARAN BERHASIL
    if (order.payment_status !== "paid") {
      const paymentUpdate = await fetch(
        `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&payment_status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            payment_status: "paid"
          })
        }
      );

      if (!paymentUpdate.ok) {
        throw new Error(await paymentUpdate.text());
      }
    }

    // HANYA KLAIM PESANAN PENDING SATU KALI
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

    if (!claimedOrders.length) {
      return res.status(200).json({
        success: true,
        message: "Pesanan sudah diproses atau sedang diproses",
        order_id,
        payment_status: "paid",
        topup_status: order.topup_status
      });
    }

    // KIRIM TRANSAKSI DIGIFLAZZ
    let result;

    try {
      result = await sendDigiflazz(claimedOrders[0]);
    } catch (error) {
      console.error("DIGIFLAZZ_SEND_ERROR:", error.message);

      // Jangan kirim ulang otomatis karena hasil bisa ambigu.
      return res.status(200).json({
        success: true,
        message: "Hasil pengiriman belum dapat dipastikan; perlu pemeriksaan",
        order_id,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // BACA HASIL DIGIFLAZZ
    const digiflazzStatus = String(
      result?.status || ""
    ).toLowerCase();

    let topupStatus = "processing";

    if (digiflazzStatus === "sukses") {
      topupStatus = "success";
    } else if (digiflazzStatus === "gagal") {
      topupStatus = "failed";
    }

    // SIMPAN HASIL KE SUPABASE
    const saveResult = await fetch(
      `${baseUrl}?order_id=eq.${encodeURIComponent(order_id)}&topup_status=eq.processing`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
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
      success: true,
      message: "Notifikasi pembayaran dan top-up diproses",
      order_id,
      payment_status: "paid",
      topup_status: topupStatus,
      digiflazz_status: result.status
    });

  } catch (error) {
    console.error(
      "MIDTRANS_NOTIFICATION_ERROR:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server"
    });
  }
};
