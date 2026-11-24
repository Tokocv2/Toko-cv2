
const crypto = require("crypto");
const sendDigiflazz = require("../lib/digiflazz");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

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

    const mode = String(MIDTRANS_MODE).trim().toLowerCase();

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

    // VALIDASI DATA NOTIFIKASI
    if (
      typeof order_id !== "string" ||
      !order_id.trim() ||
      typeof status_code !== "string" ||
      !status_code.trim() ||
      typeof gross_amount !== "string" ||
      !gross_amount.trim() ||
      typeof signature_key !== "string" ||
      typeof transaction_status !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Data notifikasi tidak lengkap"
      });
    }

    const cleanOrderId = order_id.trim();

    if (
      cleanOrderId.length > 100 ||
      !/^[a-f0-9]{128}$/i.test(signature_key)
    ) {
      return res.status(401).json({
        success: false,
        message: "Data atau signature tidak valid"
      });
    }

    // VERIFIKASI SIGNATURE MIDTRANS
    const expectedSignature = crypto
      .createHash("sha512")
      .update(
        cleanOrderId +
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

    const encodedOrderId = encodeURIComponent(cleanOrderId);

    // FUNGSI MENGAMBIL PESANAN TERBARU
    async function getOrder() {
      const response = await fetch(
        `${baseUrl}?order_id=eq.${encodedOrderId}` +
        "&select=order_id,sku,customer_no,selling_price,payment_status,topup_status" +
        "&limit=1",
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000)
        }
      );

      if (!response.ok) {
        throw new Error("Gagal mengambil data pesanan");
      }

      const orders = await response.json();

      return orders[0] || null;
    }

    const order = await getOrder();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Pesanan tidak ditemukan"
      });
    }

    // VALIDASI NOMINAL
    const notificationAmount = Number(gross_amount);
    const orderAmount = Number(order.selling_price);

    if (
      !Number.isSafeInteger(notificationAmount) ||
      notificationAmount <= 0 ||
      !Number.isSafeInteger(orderAmount) ||
      orderAmount <= 0 ||
      notificationAmount !== orderAmount
    ) {
      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak cocok"
      });
    }

    // TENTUKAN STATUS PEMBAYARAN
    const status = transaction_status.toLowerCase();

    const paid =
      status === "settlement" ||
      (
        status === "capture" &&
        String(fraud_status || "").toLowerCase() === "accept"
      );

    let paymentStatus = "pending";

    if (paid) {
      paymentStatus = "paid";
    } else if (status === "expire") {
      paymentStatus = "expired";
    } else if (
      status === "cancel" ||
      status === "deny"
    ) {
      paymentStatus = "failed";
    } else if (
      status !== "pending" &&
      status !== "capture"
    ) {
      // Status seperti refund/chargeback perlu penanganan terpisah.
      // Jangan memicu top-up dari status yang tidak dikenal.
      return res.status(200).json({
        success: true,
        message: "Status transaksi tidak memicu proses top-up",
        order_id: cleanOrderId,
        transaction_status: status,
        payment_status: order.payment_status,
        topup_status: order.topup_status
      });
    }

    // NOTIFIKASI BELUM BERHASIL DIBAYAR
    if (!paid) {
      if (order.payment_status === "paid") {
        return res.status(200).json({
          success: true,
          message: "Pembayaran sudah tercatat berhasil",
          order_id: cleanOrderId,
          payment_status: "paid",
          topup_status: order.topup_status
        });
      }

      if (
        paymentStatus === "expired" ||
        paymentStatus === "failed"
      ) {
        const update = await fetch(
          `${baseUrl}?order_id=eq.${encodedOrderId}` +
          "&payment_status=eq.pending",
          {
            method: "PATCH",
            headers: {
              ...headers,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              payment_status: paymentStatus
            }),
            signal: AbortSignal.timeout(15000)
          }
        );

        if (!update.ok) {
          throw new Error("Gagal memperbarui status pembayaran");
        }
      }

      return res.status(200).json({
        success: true,
        order_id: cleanOrderId,
        payment_status: paymentStatus
      });
    }

    // PEMBAYARAN BERHASIL
    // Jangan mengubah status lain seperti refunded.
    if (
      !["pending", "expired", "failed", "paid"].includes(
        order.payment_status
      )
    ) {
      return res.status(200).json({
        success: true,
        message: "Status pesanan tidak mengizinkan proses top-up",
        order_id: cleanOrderId,
        payment_status: order.payment_status
      });
    }

    // UBAH STATUS PEMBAYARAN MENJADI PAID
    if (order.payment_status !== "paid") {
      const paymentUpdate = await fetch(
        `${baseUrl}?order_id=eq.${encodedOrderId}` +
        "&payment_status=in.(pending,expired,failed)",
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            payment_status: "paid"
          }),
          signal: AbortSignal.timeout(15000)
        }
      );

      if (!paymentUpdate.ok) {
        throw new Error("Gagal memperbarui status pembayaran");
      }

      const updatedPayment = await paymentUpdate.json();

      // Jika callback lain lebih dahulu mengubah status,
      // periksa kembali kondisi pesanan.
      if (!Array.isArray(updatedPayment) || updatedPayment.length === 0) {
        const latestOrder = await getOrder();

        if (!latestOrder || latestOrder.payment_status !== "paid") {
          throw new Error("Status pembayaran belum berhasil diverifikasi");
        }
      }
    }

    // KLAIM ATOMIK TOP-UP
    // Hanya satu callback yang dapat mengubah pending menjadi processing.
    const claimResponse = await fetch(
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      "&payment_status=eq.paid" +
      "&topup_status=eq.pending" +
      "&select=order_id,sku,customer_no",
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          topup_status: "processing"
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!claimResponse.ok) {
      throw new Error("Gagal mengunci proses top-up");
    }

    const claimedOrders = await claimResponse.json();

    if (
      !Array.isArray(claimedOrders) ||
      claimedOrders.length === 0
    ) {
      const latestOrder = await getOrder();

      return res.status(200).json({
        success: true,
        message: "Pesanan sudah diproses atau sedang diproses",
        order_id: cleanOrderId,
        payment_status: latestOrder?.payment_status || "paid",
        topup_status: latestOrder?.topup_status || "unknown"
      });
    }

    // KIRIM TOP-UP KE DIGIFLAZZ
    let result;

    try {
      result = await sendDigiflazz(claimedOrders[0]);
    } catch (error) {
      console.error(
        "DIGIFLAZZ_SEND_ERROR:",
        error.message
      );

      // Jangan mengembalikan status menjadi pending.
      // Permintaan mungkin sudah diterima Digiflazz.
      return res.status(200).json({
        success: true,
        message:
          "Hasil pengiriman belum dapat dipastikan. Perlu pemeriksaan.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // TENTUKAN STATUS HASIL DIGIFLAZZ
    const digiflazzStatus = String(
      result?.status || ""
    ).trim().toLowerCase();

    let topupStatus = "processing";

    if (digiflazzStatus === "sukses") {
      topupStatus = "success";
    } else if (digiflazzStatus === "gagal") {
      topupStatus = "failed";
    }

    // SIMPAN HASIL TOP-UP
    const saveResult = await fetch(
      `${baseUrl}?order_id=eq.${encodedOrderId}` +
      "&topup_status=eq.processing",
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          topup_status: topupStatus
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!saveResult.ok) {
      throw new Error("Gagal menyimpan hasil top-up");
    }

    const savedRows = await saveResult.json();

    if (!Array.isArray(savedRows) || savedRows.length !== 1) {
      const latestOrder = await getOrder();

      return res.status(200).json({
        success: true,
        message: "Hasil top-up sudah berubah atau perlu pemeriksaan",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: latestOrder?.topup_status || "processing"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notifikasi pembayaran dan top-up berhasil diproses",
      order_id: cleanOrderId,
      payment_status: "paid",
      topup_status: topupStatus,
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
