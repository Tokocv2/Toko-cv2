
const crypto = require("node:crypto");
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
    MIDTRANS_SIGNATURE_SECRET
  } = process.env;

  try {
    // VALIDASI ENVIRONMENT VARIABLES
    const missing = [];

    if (!SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!SUPABASE_SECRET_KEY) missing.push("SUPABASE_SECRET_KEY");
    if (!MIDTRANS_SIGNATURE_SECRET) {
      missing.push("MIDTRANS_SIGNATURE_SECRET");
    }

    if (missing.length) {
      console.error(
        "MIDTRANS_NOTIFICATION_MISSING_ENV:",
        missing.join(", ")
      );

      throw new Error("Environment variable belum lengkap");
    }

    const mode = String(MIDTRANS_MODE).trim().toLowerCase();

    if (!["sandbox", "production"].includes(mode)) {
      throw new Error("MIDTRANS_MODE tidak valid");
    }

    // AMBIL DATA NOTIFIKASI
    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status,
      fraud_status
    } = req.body || {};

    if (
      typeof order_id !== "string" ||
      !order_id.trim() ||
      !["string", "number"].includes(typeof status_code) ||
      !["string", "number"].includes(typeof gross_amount) ||
      typeof signature_key !== "string" ||
      typeof transaction_status !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Data notifikasi tidak lengkap"
      });
    }

    const cleanOrderId = order_id.trim();
    const cleanStatusCode = String(status_code).trim();
    const cleanGrossAmount = String(gross_amount).trim();

    if (
      cleanOrderId.length > 100 ||
      !cleanStatusCode ||
      !cleanGrossAmount ||
      !/^[a-f0-9]{128}$/i.test(signature_key)
    ) {
      return res.status(400).json({
        success: false,
        message: "Data atau signature tidak valid"
      });
    }

    // VERIFIKASI SIGNATURE MIDTRANS
    const expectedSignature = crypto
      .createHash("sha512")
      .update(
        cleanOrderId +
        cleanStatusCode +
        cleanGrossAmount +
        MIDTRANS_SIGNATURE_SECRET
      )
      .digest("hex");

    const received = Buffer.from(signature_key, "hex");
    const expected = Buffer.from(expectedSignature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      console.error(
        "MIDTRANS_INVALID_SIGNATURE:",
        cleanOrderId
      );

      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

    // KONEKSI SUPABASE
    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    const baseUrl =
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/orders`;

    const encodedOrderId = encodeURIComponent(cleanOrderId);

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
    const notificationAmount = Number(cleanGrossAmount);
    const orderAmount = Number(order.selling_price);

    if (
      !Number.isSafeInteger(notificationAmount) ||
      notificationAmount <= 0 ||
      !Number.isSafeInteger(orderAmount) ||
      orderAmount <= 0 ||
      notificationAmount !== orderAmount
    ) {
      console.error(
        "MIDTRANS_AMOUNT_MISMATCH:",
        cleanOrderId
      );

      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak cocok"
      });
    }

    // TENTUKAN STATUS PEMBAYARAN
    const status = transaction_status.trim().toLowerCase();

    const paid =
      cleanStatusCode === "200" &&
      (
        status === "settlement" ||
        (
          status === "capture" &&
          String(fraud_status || "").toLowerCase() === "accept"
        )
      );

    let paymentStatus = "pending";

    if (paid) {
      paymentStatus = "paid";
    } else if (status === "expire") {
      paymentStatus = "expired";
    } else if (status === "cancel" || status === "deny") {
      paymentStatus = "failed";
    } else if (status !== "pending" && status !== "capture") {
      return res.status(200).json({
        success: true,
        message: "Status transaksi tidak memicu proses top-up",
        order_id: cleanOrderId,
        transaction_status: status,
        payment_status: order.payment_status,
        topup_status: order.topup_status
      });
    }

    // PEMBAYARAN BELUM BERHASIL
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

    // PEMBAYARAN TERLAMBAT
    if (
      order.payment_status === "expired" ||
      order.payment_status === "failed"
    ) {
      console.error(
        "MIDTRANS_LATE_PAYMENT_REVIEW:",
        cleanOrderId
      );

      return res.status(200).json({
        success: true,
        message: "Pembayaran terlambat perlu pemeriksaan manual",
        order_id: cleanOrderId,
        payment_status: order.payment_status,
        topup_status: order.topup_status
      });
    }

    if (!["pending", "paid"].includes(order.payment_status)) {
      return res.status(200).json({
        success: true,
        message: "Status pesanan tidak mengizinkan top-up",
        order_id: cleanOrderId,
        payment_status: order.payment_status
      });
    }

    // UBAH PEMBAYARAN PENDING MENJADI PAID
    if (order.payment_status === "pending") {
      const paymentUpdate = await fetch(
        `${baseUrl}?order_id=eq.${encodedOrderId}` +
        "&payment_status=eq.pending",
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

      if (
        !Array.isArray(updatedPayment) ||
        updatedPayment.length === 0
      ) {
        const latestOrder = await getOrder();

        if (
          !latestOrder ||
          latestOrder.payment_status !== "paid"
        ) {
          throw new Error(
            "Status pembayaran belum berhasil diverifikasi"
          );
        }
      }
    }

    // PERLINDUNGAN SANDBOX
    if (mode === "sandbox") {
      console.log(
        "MIDTRANS_SANDBOX_PAYMENT_CONFIRMED:",
        cleanOrderId
      );

      return res.status(200).json({
        success: true,
        message: "Pembayaran Sandbox tercatat. Digiflazz tidak dipanggil.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: order.topup_status
      });
    }

    // KLAIM ATOMIK TOP-UP PRODUCTION
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

    const claimedOrder = claimedOrders[0];

    // VALIDASI DATA PESANAN SEBELUM DIGIFLAZZ
    if (
      claimedOrder.order_id !== cleanOrderId ||
      claimedOrder.sku !== order.sku ||
      claimedOrder.customer_no !== order.customer_no
    ) {
      console.error(
        "MIDTRANS_CLAIM_DATA_MISMATCH:",
        cleanOrderId
      );

      return res.status(200).json({
        success: true,
        message: "Data pesanan tidak cocok. Perlu pemeriksaan manual.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // KIRIM TOP-UP KE DIGIFLAZZ
    let result;

    try {
      result = await sendDigiflazz(claimedOrder);
    } catch (error) {
      console.error(
        "DIGIFLAZZ_RESULT_UNCERTAIN:",
        cleanOrderId,
        error.message
      );

      return res.status(200).json({
        success: true,
        message: "Hasil Digiflazz belum dapat dipastikan. Jangan kirim ulang otomatis.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // VALIDASI IDENTITAS RESPONS DIGIFLAZZ
    if (
      !result ||
      String(result.ref_id || "") !== cleanOrderId ||
      String(result.buyer_sku_code || "") !== claimedOrder.sku ||
      String(result.customer_no || "") !== claimedOrder.customer_no
    ) {
      console.error(
        "DIGIFLAZZ_RESPONSE_MISMATCH:",
        cleanOrderId
      );

      return res.status(200).json({
        success: true,
        message: "Identitas respons Digiflazz tidak cocok. Perlu pemeriksaan manual.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

    // TENTUKAN STATUS TOP-UP
    const digiflazzStatus = String(
      result.status || ""
    ).trim().toLowerCase();

    let topupStatus = "processing";

    if (digiflazzStatus === "sukses") {
      topupStatus = "success";
    } else if (digiflazzStatus === "gagal") {
      topupStatus = "failed";
    } else if (digiflazzStatus !== "pending") {
      console.error(
        "DIGIFLAZZ_UNKNOWN_STATUS:",
        cleanOrderId,
        digiflazzStatus
      );

      return res.status(200).json({
        success: true,
        message: "Status Digiflazz tidak dikenali. Perlu pemeriksaan manual.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
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
      console.error(
        "DIGIFLAZZ_RESULT_SAVE_FAILED:",
        cleanOrderId
      );

      throw new Error("Gagal menyimpan hasil top-up");
    }

    const savedRows = await saveResult.json();

    if (!Array.isArray(savedRows) || savedRows.length !== 1) {
      const latestOrder = await getOrder();

      return res.status(200).json({
        success: true,
        message: "Hasil top-up berubah atau perlu pemeriksaan manual",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: latestOrder?.topup_status || "processing"
      });
    }

    console.log(
      "MIDTRANS_TOPUP_PROCESSED:",
      cleanOrderId,
      topupStatus
    );

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
      
