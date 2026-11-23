
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
    MIDTRANS_MODE = "sandbox",
    MIDTRANS_SERVER_KEY
  } = process.env;

  try {
    if (
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY ||
      !MIDTRANS_SERVER_KEY
    ) {
      throw new Error("Environment variable belum lengkap");
    }

    const mode = MIDTRANS_MODE.toLowerCase();

    if (!["sandbox", "production"].includes(mode)) {
      throw new Error("MIDTRANS_MODE tidak valid");
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
        message: "Data notifikasi tidak lengkap"
      });
    }

    // Validasi format signature SHA512
    if (!/^[a-f0-9]{128}$/i.test(signature_key)) {
      return res.status(401).json({
        success: false,
        message: "Format signature tidak valid"
      });
    }

    // Verifikasi signature Midtrans
    const expectedSignature = crypto
      .createHash("sha512")
      .update(
        order_id +
        status_code +
        gross_amount +
        MIDTRANS_SERVER_KEY
      )
      .digest("hex");

    const received = Buffer.from(signature_key, "hex");
    const expected = Buffer.from(expectedSignature, "hex");

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

    const encodedOrderId = encodeURIComponent(order_id);

    // Cari pesanan
    const findResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      `&select=order_id,sku,customer_no,selling_price,payment_status,topup_status`,
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

    // Validasi nominal
    if (
      !Number.isFinite(Number(gross_amount)) ||
      Number(gross_amount) !== Number(order.selling_price)
    ) {
      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak cocok"
      });
    }

    // Tentukan status pembayaran
    const paid =
      transaction_status === "settlement" ||
      (
        transaction_status === "capture" &&
        fraud_status === "accept"
      );

    let paymentStatus = "pending";

    if (paid) {
      paymentStatus = "paid";
    } else if (transaction_status === "expire") {
      paymentStatus = "expired";
    } else if (
      transaction_status === "cancel" ||
      transaction_status === "deny"
    ) {
      paymentStatus = "failed";
    }

    // Notifikasi pembayaran belum berhasil
    if (!paid) {
      if (order.payment_status === "paid") {
        return res.status(200).json({
          success: true,
          message: "Pembayaran sudah tercatat berhasil",
          order_id,
          payment_status: "paid",
          topup_status: order.topup_status
        });
      }

      if (paymentStatus !== "pending") {
        const update = await fetch(
          `${baseUrl}?order_id=eq.${encodedOrderId}` +
          `&payment_status=eq.pending`,
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
      }

      return res.status(200).json({
        success: true,
        order_id,
        payment_status: paymentStatus
      });
    }

    // Pembayaran berhasil:
    // Izinkan pending, expired, atau failed menjadi paid
    if (order.payment_status !== "paid") {
      const paymentUpdate = await fetch(
        `${baseUrl}?order_id=eq.${encodedOrderId}` +
        `&payment_status=in.(pending,expired,failed)`,
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

    // Klaim atomik: hanya satu proses yang boleh mengirim top-up
    const claimResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      `&payment_status=eq.paid` +
      `&topup_status=eq.pending` +
      `&select=order_id,sku,customer_no`,
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

    // Kirim transaksi Digiflazz satu kali
    let result;

    try {
      result = await sendDigiflazz(claimedOrders[0]);
    } catch (error) {
      console.error("DIGIFLAZZ_SEND_ERROR:", error.message);

      return res.status(200).json({
        success: true,
        message: "Hasil pengiriman belum dapat dipastikan. Perlu pemeriksaan.",
        order_id,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // Tentukan status top-up
    const digiflazzStatus = String(
      result?.status || ""
    ).toLowerCase();

    let topupStatus = "processing";

    if (digiflazzStatus === "sukses") {
      topupStatus = "success";
    } else if (digiflazzStatus === "gagal") {
      topupStatus = "failed";
    }

    // Simpan hasil hanya jika masih processing
    const saveResult = await fetch(
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      `&topup_status=eq.processing`,
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

    const savedRows = await saveResult.json();

    return res.status(200).json({
      success: true,
      message: "Notifikasi pembayaran dan top-up diproses",
      order_id,
      payment_status: "paid",
      topup_status: savedRows.length
        ? topupStatus
        : "Sudah diperbarui webhook",
      digiflazz_status: digiflazzStatus
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
