
const crypto = require("node:crypto");
const sendDigiflazz = require("../lib/digiflazz");

const REFUND_REASON = "Top-up Digiflazz gagal";

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function createRefundKey(orderId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(orderId))
    .digest("hex")
    .slice(0, 32);

  // Harus sama persis dengan api/digiflazz-webhook.js
  return `TCV2-REF-${hash}`;
}

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
    MIDTRANS_SIGNATURE_SECRET,
    MIDTRANS_SERVER_KEY
  } = process.env;

  try {
    // VALIDASI ENVIRONMENT
    const missing = [];

    if (!SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!SUPABASE_SECRET_KEY) missing.push("SUPABASE_SECRET_KEY");
    if (!MIDTRANS_SIGNATURE_SECRET) {
      missing.push("MIDTRANS_SIGNATURE_SECRET");
    }

    const serverKey =
      MIDTRANS_SERVER_KEY || MIDTRANS_SIGNATURE_SECRET;

    if (!serverKey) missing.push("MIDTRANS_SERVER_KEY");

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

    const midtransBase =
      mode === "production"
        ? "https://api.midtrans.com"
        : "https://api.sandbox.midtrans.com";

    const baseUrl =
      `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/orders`;

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    const authorization =
      "Basic " +
      Buffer.from(`${serverKey}:`).toString("base64");

    async function updateOrder(path, body) {
      const response = await fetch(`${baseUrl}?${path}`, {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase update gagal: ${text}`);
      }

      return text ? JSON.parse(text) : [];
    }

    async function getOrder(orderId) {
      const query = new URLSearchParams({
        order_id: `eq.${orderId}`,
        select: [
          "order_id",
          "sku",
          "customer_no",
          "selling_price",
          "payment_status",
          "topup_status",
          "refund_status",
          "refund_key",
          "refund_amount",
          "refund_requested_at",
          "refund_confirmed_at",
          "midtrans_transaction_id"
        ].join(","),
        limit: "1"
      });

      const response = await fetch(`${baseUrl}?${query}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error("Gagal mengambil data pesanan");
      }

      const orders = await response.json();
      return orders[0] || null;
    }

    async function getMidtransStatus(orderId) {
      const response = await fetch(
        `${midtransBase}/v2/${encodeURIComponent(orderId)}/status`,
        {
          method: "GET",
          headers: {
            Authorization: authorization,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(15000)
        }
      );

      const text = await response.text();

      let result;

      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("Respons status Midtrans tidak valid");
      }

      if (!response.ok) {
        throw new Error(
          `Gagal memeriksa status Midtrans: ${text}`
        );
      }

      return result;
    }

    // MEMINTA REFUND DENGAN KUNCI YANG KONSISTEN
    async function processRefund(orderId) {
      let order = await getOrder(orderId);

      if (!order) {
        return {
          message: "Pesanan tidak ditemukan"
        };
      }

      if (
        order.payment_status !== "paid" ||
        order.topup_status !== "failed"
      ) {
        return {
          message: "Pesanan belum memenuhi syarat refund",
          refund_status: order.refund_status
        };
      }

      if (order.refund_status !== "not_requested") {
        return {
          message: "Refund sudah diproses atau perlu pemeriksaan",
          refund_status: order.refund_status
        };
      }

      // Refund hanya boleh diminta setelah Settlement.
      const transaction = await getMidtransStatus(orderId);

      if (
        String(transaction.transaction_status || "").toLowerCase() !==
        "settlement"
      ) {
        return {
          message: "Menunggu transaksi Midtrans berstatus settlement",
          refund_status: order.refund_status,
          midtrans_status: transaction.transaction_status || "unknown"
        };
      }

      const amount = Number(order.selling_price);
      const paidAmount = Number(transaction.gross_amount);

      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        !Number.isFinite(paidAmount) ||
        paidAmount !== amount
      ) {
        throw new Error("Nominal refund tidak cocok dengan transaksi Midtrans");
      }

      const refundKey = createRefundKey(orderId);

      // KLAIM REFUND SECARA ATOMIK
      const claimPath =
        `order_id=eq.${encodeURIComponent(orderId)}` +
        "&payment_status=eq.paid" +
        "&topup_status=eq.failed" +
        "&refund_status=eq.not_requested";

      const claimed = await updateOrder(claimPath, {
        refund_status: "requesting",
        refund_key: refundKey,
        refund_amount: amount,
        refund_requested_at: new Date().toISOString(),
        midtrans_transaction_id: transaction.transaction_id || null
      });

      if (!claimed.length) {
        return {
          message: "Refund sudah diklaim proses lain"
        };
      }

      // KIRIM PERMINTAAN REFUND KE MIDTRANS
      let response;
      let result = {};

      try {
        response = await fetch(
          `${midtransBase}/v2/${encodeURIComponent(orderId)}/refund`,
          {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: JSON.stringify({
              refund_key: refundKey,
              amount,
              reason: REFUND_REASON
            }),
            signal: AbortSignal.timeout(20000)
          }
        );

        const text = await response.text();

        try {
          result = text ? JSON.parse(text) : {};
        } catch {
          throw new Error("Respons refund Midtrans tidak valid");
        }

        if (!response.ok) {
          const error = new Error(
            `Midtrans menolak refund: ${text}`
          );

          error.definitiveRejected =
            response.status >= 400 && response.status < 500;

          throw error;
        }

      } catch (error) {
        // Penolakan jelas perlu pemeriksaan.
        // Timeout/5xx tidak boleh dicoba ulang secara membabi buta.
        if (error.definitiveRejected) {
          const reviewPath =
            `order_id=eq.${encodeURIComponent(orderId)}` +
            `&refund_key=eq.${encodeURIComponent(refundKey)}` +
            "&refund_status=eq.requesting";

          await updateOrder(reviewPath, {
            refund_status: "needs_review"
          });
        }

        console.error("MIDTRANS_REFUND_REQUEST_ERROR:", {
          orderId,
          refundKey,
          error: error.message
        });

        return {
          message: "Hasil permintaan refund belum dapat dipastikan atau ditolak",
          refund_status: error.definitiveRejected
            ? "needs_review"
            : "requesting"
        };
      }

      // Midtrans menerima permintaan, belum berarti bank sudah
      // mengonfirmasi uang kembali ke pelanggan.
      const requestedPath =
        `order_id=eq.${encodeURIComponent(orderId)}` +
        `&refund_key=eq.${encodeURIComponent(refundKey)}` +
        "&refund_status=eq.requesting";

      await updateOrder(requestedPath, {
        refund_status: "requested",
        midtrans_transaction_id:
          result.transaction_id ||
          transaction.transaction_id ||
          null
      });

      console.log("MIDTRANS_REFUND_REQUESTED:", {
        orderId,
        refundKey,
        amount
      });

      return {
        message: "Permintaan refund diterima Midtrans",
        refund_status: "requested",
        refund_amount: amount
      };
    }

    // AMBIL DAN VALIDASI NOTIFIKASI
    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status,
      fraud_status,
      refunds,
      transaction_id
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

    if (!safeEqual(signature_key.toLowerCase(), expectedSignature)) {
      console.error("MIDTRANS_INVALID_SIGNATURE:", cleanOrderId);

      return res.status(401).json({
        success: false,
        message: "Signature tidak valid"
      });
    }

    let order = await getOrder(cleanOrderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Pesanan tidak ditemukan"
      });
    }

    // VALIDASI NOMINAL TRANSAKSI
    const notificationAmount = Number(cleanGrossAmount);
    const orderAmount = Number(order.selling_price);

    if (
      !Number.isSafeInteger(notificationAmount) ||
      notificationAmount <= 0 ||
      !Number.isSafeInteger(orderAmount) ||
      orderAmount <= 0 ||
      notificationAmount !== orderAmount
    ) {
      console.error("MIDTRANS_AMOUNT_MISMATCH:", cleanOrderId);

      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak cocok"
      });
    }

    // PROSES NOTIFIKASI REFUND
    // Hanya konfirmasi bank yang mengubah status menjadi confirmed.
    if (
      Array.isArray(refunds) &&
      refunds.length > 0
    ) {
      const matchingRefund = refunds.find(
        item =>
          item &&
          String(item.refund_key || "") ===
            String(order.refund_key || "")
      );

      if (!matchingRefund) {
        return res.status(200).json({
          success: true,
          message: "Notifikasi refund tidak cocok dengan refund_key pesanan",
          order_id: cleanOrderId,
          refund_status: order.refund_status
        });
      }

      const refundAmount = Number(matchingRefund.refund_amount);
      const expectedRefundAmount = Number(order.refund_amount);

      if (
        !Number.isSafeInteger(refundAmount) ||
        !Number.isSafeInteger(expectedRefundAmount) ||
        refundAmount !== expectedRefundAmount
      ) {
        console.error("MIDTRANS_REFUND_AMOUNT_MISMATCH:", cleanOrderId);

        return res.status(400).json({
          success: false,
          message: "Nominal konfirmasi refund tidak cocok"
        });
      }

      if (!matchingRefund.bank_confirmed_at) {
        return res.status(200).json({
          success: true,
          message: "Refund diterima Midtrans, menunggu konfirmasi bank",
          order_id: cleanOrderId,
          refund_status: order.refund_status
        });
      }

      if (
        !["requesting", "requested", "confirmed"].includes(
          order.refund_status
        )
      ) {
        return res.status(200).json({
          success: true,
          message: "Status refund perlu pemeriksaan manual",
          order_id: cleanOrderId,
          refund_status: order.refund_status
        });
      }

      const confirmedPath =
        `order_id=eq.${encodeURIComponent(cleanOrderId)}` +
        `&refund_key=eq.${encodeURIComponent(order.refund_key)}` +
        "&refund_status=in.(requesting,requested,confirmed)";

      await updateOrder(confirmedPath, {
        refund_status: "confirmed",
        refund_confirmed_at: matchingRefund.bank_confirmed_at,
        midtrans_transaction_id:
          transaction_id || order.midtrans_transaction_id
      });

      console.log("MIDTRANS_REFUND_CONFIRMED:", cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Refund telah dikonfirmasi bank",
        order_id: cleanOrderId,
        refund_status: "confirmed"
      });
    }

    const status = transaction_status.trim().toLowerCase();

    // STATUS PEMBAYARAN
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
        const updatePath =
          `order_id=eq.${encodeURIComponent(cleanOrderId)}` +
          "&payment_status=eq.pending";

        await updateOrder(updatePath, {
          payment_status: paymentStatus
        });
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
      console.error("MIDTRANS_LATE_PAYMENT_REVIEW:", cleanOrderId);

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

    // UBAH PENDING MENJADI PAID
    if (order.payment_status === "pending") {
      const paymentPath =
        `order_id=eq.${encodeURIComponent(cleanOrderId)}` +
        "&payment_status=eq.pending";

      const updatedPayment = await updateOrder(paymentPath, {
        payment_status: "paid",
        midtrans_transaction_id: transaction_id || null
      });

      if (!updatedPayment.length) {
        order = await getOrder(cleanOrderId);

        if (!order || order.payment_status !== "paid") {
          throw new Error("Status pembayaran belum berhasil diverifikasi");
        }
      }
    } else if (transaction_id) {
      await updateOrder(
        `order_id=eq.${encodeURIComponent(cleanOrderId)}`,
        {
          midtrans_transaction_id: transaction_id
        }
      );
    }

    // SANDBOX TIDAK BOLEH MENGIRIM TOP-UP
    if (mode === "sandbox") {
      console.log("MIDTRANS_SANDBOX_PAYMENT_CONFIRMED:", cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Pembayaran Sandbox tercatat. Digiflazz tidak dipanggil.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: order.topup_status
      });
    }

    // JIKA TOP-UP SUDAH GAGAL, COBA REFUND.
    // processRefund sendiri memeriksa Settlement dan mengunci refund.
    order = await getOrder(cleanOrderId);

    if (order && order.topup_status === "failed") {
      const refundResult = await processRefund(cleanOrderId);

      return res.status(200).json({
        success: true,
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "failed",
        ...refundResult
      });
    }

    // KLAIM ATOMIK TOP-UP
    const claimPath =
      `order_id=eq.${encodeURIComponent(cleanOrderId)}` +
      "&payment_status=eq.paid" +
      "&topup_status=eq.pending" +
      "&select=order_id,sku,customer_no";

    const claimedOrders = await updateOrder(claimPath, {
      topup_status: "processing"
    });

    if (!claimedOrders.length) {
      const latestOrder = await getOrder(cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Pesanan sudah diproses atau sedang diproses",
        order_id: cleanOrderId,
        payment_status: latestOrder?.payment_status || "paid",
        topup_status: latestOrder?.topup_status || "unknown"
      });
    }

    const claimedOrder = claimedOrders[0];

    // VALIDASI IDENTITAS PESANAN
    if (
      claimedOrder.order_id !== cleanOrderId ||
      claimedOrder.sku !== order.sku ||
      claimedOrder.customer_no !== order.customer_no
    ) {
      console.error("MIDTRANS_CLAIM_DATA_MISMATCH:", cleanOrderId);

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

    // VALIDASI RESPONS DIGIFLAZZ
    if (
      !result ||
      String(result.ref_id || "") !== cleanOrderId ||
      String(result.buyer_sku_code || "") !== claimedOrder.sku ||
      String(result.customer_no || "") !== claimedOrder.customer_no
    ) {
      console.error("DIGIFLAZZ_RESPONSE_MISMATCH:", cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Identitas respons Digiflazz tidak cocok. Perlu pemeriksaan manual.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "processing"
      });
    }

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
    const savePath =
      `order_id=eq.${encodeURIComponent(cleanOrderId)}` +
      "&topup_status=eq.processing";

    const savedRows = await updateOrder(savePath, {
      topup_status: topupStatus
    });

    if (savedRows.length !== 1) {
      const latestOrder = await getOrder(cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Hasil top-up berubah atau perlu pemeriksaan manual",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: latestOrder?.topup_status || "processing"
      });
    }

    console.log("MIDTRANS_TOPUP_PROCESSED:", cleanOrderId, topupStatus);

    // JIKA GAGAL, AJUKAN REFUND.
    if (topupStatus === "failed") {
      const refundResult = await processRefund(cleanOrderId);

      return res.status(200).json({
        success: true,
        message: "Top-up gagal. Proses refund diperiksa.",
        order_id: cleanOrderId,
        payment_status: "paid",
        topup_status: "failed",
        ...refundResult
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
