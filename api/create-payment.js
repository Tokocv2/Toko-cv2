
export default async function handler(req, res) {
  const {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    MIDTRANS_MODE = "sandbox",
    MIDTRANS_SERVER_KEY
  } = process.env;

  const mode = String(MIDTRANS_MODE).trim().toLowerCase();
  const midtransServerKey = String(MIDTRANS_SERVER_KEY || "").trim();

  // Endpoint ini hanya menerima POST.
  // Diagnostik autentikasi publik dinonaktifkan.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  if (!["sandbox", "production"].includes(mode)) {
    return res.status(500).json({
      success: false,
      message: "MIDTRANS_MODE harus sandbox atau production"
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !midtransServerKey) {
    return res.status(500).json({
      success: false,
      message: "Environment Variables belum lengkap"
    });
  }

  const keyFormatValid =
    mode === "sandbox"
      ? midtransServerKey.startsWith("SB-Mid-server-")
      : midtransServerKey.startsWith("Mid-server-");

  if (!keyFormatValid) {
    return res.status(500).json({
      success: false,
      message: "Server Key tidak sesuai dengan mode Midtrans"
    });
  }

  const { order_id, sku, customer_no } = req.body || {};

  if (
    typeof order_id !== "string" ||
    typeof sku !== "string" ||
    typeof customer_no !== "string" ||
    !order_id.trim() ||
    !sku.trim() ||
    !customer_no.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Data transaksi belum lengkap"
    });
  }

  const cleanOrderId = order_id.trim();
  const cleanSku = sku.trim();
  const cleanCustomerNo = customer_no.trim();

  if (
    cleanOrderId.length > 100 ||
    cleanSku.length > 200 ||
    cleanCustomerNo.length > 200
  ) {
    return res.status(400).json({
      success: false,
      message: "Data transaksi tidak valid"
    });
  }

  const supabaseUrl = SUPABASE_URL.replace(/\/+$/, "");

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json"
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  let lockClaimed = false;
  let midtransRequestStarted = false;

  // Melepas pengunci memakai timeout independen.
  // Tidak menggunakan AbortSignal request utama.
  async function releaseLock() {
    const releaseController = new AbortController();
    const releaseTimer = setTimeout(
      () => releaseController.abort(),
      10000
    );

    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/orders?order_id=eq.${encodeURIComponent(cleanOrderId)}&payment_creation_status=eq.creating&payment_status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            payment_creation_status: "idle",
            payment_lock_at: null
          }),
          signal: releaseController.signal
        }
      );

      if (!response.ok) {
        throw new Error("Gagal melepaskan pengunci pembayaran");
      }

      const updatedRows = await response.json();

      if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
        throw new Error("Status pengunci tidak berhasil diverifikasi");
      }

      lockClaimed = false;
    } finally {
      clearTimeout(releaseTimer);
    }
  }

  try {
    // LOGIN OPSIONAL
    let user = null;

    const authorization = req.headers.authorization;

    if (authorization) {
      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          message: "Format token login tidak valid"
        });
      }

      const token = authorization.slice(7).trim();

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Token login kosong"
        });
      }

      const authResponse = await fetch(
        `${supabaseUrl}/auth/v1/user`,
        {
          method: "GET",
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal
        }
      );

      if (!authResponse.ok) {
        return res.status(401).json({
          success: false,
          message: "Token login tidak valid"
        });
      }

      user = await authResponse.json();

      if (!user?.id) {
        return res.status(401).json({
          success: false,
          message: "Identitas pengguna tidak valid"
        });
      }
    }

    // CARI PESANAN
    const params = new URLSearchParams({
      select:
        "order_id,user_id,sku,customer_no,product_name,selling_price,payment_status,payment_creation_status",
      order_id: `eq.${cleanOrderId}`,
      limit: "1"
    });

    // Pesanan login hanya dapat diakses pemiliknya.
    // Checkout tamu hanya mencari pesanan tanpa user_id.
    if (user) {
      params.set("user_id", `eq.${user.id}`);
    } else {
      params.set("user_id", "is.null");
    }

    const orderResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?${params}`,
      {
        method: "GET",
        headers,
        signal: controller.signal
      }
    );

    if (!orderResponse.ok) {
      throw new Error("Gagal mengambil data pesanan");
    }

    const orders = await orderResponse.json();
    const order = orders[0];

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Pesanan tidak ditemukan"
      });
    }

    if (
      order.sku !== cleanSku ||
      order.customer_no !== cleanCustomerNo
    ) {
      return res.status(400).json({
        success: false,
        message: "Data pesanan tidak cocok"
      });
    }

    if (order.payment_status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Pesanan bukan berstatus pending"
      });
    }

    if (
      order.payment_creation_status === "creating" ||
      order.payment_creation_status === "created"
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Pembayaran untuk pesanan ini sudah diproses. Jangan membuat tagihan baru.",
        order_id: cleanOrderId
      });
    }

    if (order.payment_creation_status !== "idle") {
      return res.status(409).json({
        success: false,
        message: "Status penguncian pembayaran tidak dikenal"
      });
    }

    const amount = Number(order.selling_price);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak valid"
      });
    }

    // KUNCI ATOMIK SUPABASE
    const lockResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/claim_order_payment_lock`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_order_id: cleanOrderId
        }),
        signal: controller.signal
      }
    );

    if (!lockResponse.ok) {
      console.error(
        "PAYMENT_LOCK_ERROR:",
        await lockResponse.text()
      );

      throw new Error("Gagal mengunci pesanan di Supabase");
    }

    const lockResult = await lockResponse.json();

    if (lockResult !== true) {
      return res.status(409).json({
        success: false,
        message:
          "Pesanan sedang diproses atau sudah memiliki permintaan pembayaran.",
        order_id: cleanOrderId
      });
    }

    lockClaimed = true;

    // MIDTRANS QRIS
    // Tetap menggunakan QRIS sesuai alur frontend saat ini.
    const midtransUrl =
      mode === "production"
        ? "https://api.midtrans.com/v2/charge"
        : "https://api.sandbox.midtrans.com/v2/charge";

    const auth = Buffer.from(
      `${midtransServerKey}:`
    ).toString("base64");

    midtransRequestStarted = true;

    const midtransResponse = await fetch(midtransUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        payment_type: "qris",
        transaction_details: {
          order_id: order.order_id,
          gross_amount: amount
        },
        qris: {
          acquirer: "gopay"
        },
        item_details: [
          {
            id: order.sku,
            price: amount,
            quantity: 1,
            name: order.product_name || order.sku
          }
        ]
      }),
      signal: controller.signal
    });

    let payment;

    try {
      payment = await midtransResponse.json();
    } catch {
      // Respons tidak terbaca: jangan melepas pengunci.
      throw new Error("Respons Midtrans tidak dapat dibaca");
    }

    // Penolakan HTTP yang jelas dari Midtrans.
    if (!midtransResponse.ok) {
      console.error("MIDTRANS_CREATE_ERROR:", {
        httpStatus: midtransResponse.status,
        response: payment
      });

      await releaseLock();

      return res.status(400).json({
        success: false,
        message:
          payment.status_message ||
          payment.error ||
          "Midtrans menolak pembuatan pembayaran"
      });
    }

    // VALIDASI RESPONS MIDTRANS
    const qrAction = Array.isArray(payment.actions)
      ? payment.actions.find(
          action =>
            action.name === "generate-qr-code" &&
            typeof action.url === "string" &&
            action.url.startsWith("https://")
        )
      : null;

    const validPayment =
      payment &&
      String(payment.status_code) === "200" &&
      payment.order_id === order.order_id &&
      typeof payment.transaction_id === "string" &&
      payment.transaction_id.length > 0 &&
      qrAction;

    if (!validPayment) {
      console.error("MIDTRANS_INVALID_SUCCESS_RESPONSE:", {
        orderId: cleanOrderId,
        statusCode: payment?.status_code,
        hasTransactionId: Boolean(payment?.transaction_id),
        hasQrAction: Boolean(qrAction)
      });

      // Midtrans mungkin sudah membuat transaksi.
      // Pengunci sengaja dipertahankan.
      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Respons pembayaran belum lengkap. Jangan membuat pembayaran baru sebelum status Midtrans diperiksa.",
        order_id: cleanOrderId
      });
    }

    // SIMPAN STATUS PEMBAYARAN DAN URL QR
    const updateResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?order_id=eq.${encodeURIComponent(cleanOrderId)}&payment_creation_status=eq.creating&payment_status=eq.pending`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          payment_creation_status: "created",
          payment_url: qrAction.url
        }),
        signal: controller.signal
      }
    );

    if (!updateResponse.ok) {
      console.error(
        "PAYMENT_STATUS_SAVE_ERROR:",
        await updateResponse.text()
      );

      // Jangan melepas pengunci karena Midtrans sudah membuat tagihan.
      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Pembayaran mungkin sudah dibuat Midtrans, tetapi penyimpanan status internal gagal. Perlu pemeriksaan sebelum mencoba lagi.",
        order_id: cleanOrderId
      });
    }

    const updatedOrders = await updateResponse.json();

    if (!Array.isArray(updatedOrders) || updatedOrders.length !== 1) {
      console.error(
        "PAYMENT_STATUS_SAVE_UNVERIFIED:",
        cleanOrderId
      );

      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Pembayaran mungkin sudah dibuat Midtrans, tetapi status pesanan belum berhasil diverifikasi.",
        order_id: cleanOrderId
      });
    }

    lockClaimed = false;

    return res.status(200).json({
      success: true,
      mode,
      message: "Pembayaran QRIS berhasil dibuat",
      order_id: cleanOrderId,
      payment
    });

  } catch (error) {
    console.error("CREATE_PAYMENT_ERROR:", error.message);

    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError"
    ) {
      return res.status(504).json({
        success: false,
        uncertain: midtransRequestStarted,
        message: midtransRequestStarted
          ? "Respons pembayaran timeout. Jangan membuat pembayaran baru sebelum status Midtrans diperiksa."
          : "Permintaan timeout sebelum hasil pembayaran dapat dipastikan.",
        order_id: cleanOrderId
      });
    }

    return res.status(500).json({
      success: false,
      uncertain: lockClaimed,
      message: lockClaimed
        ? "Proses pembayaran belum dapat dipastikan. Pengunci dipertahankan demi mencegah tagihan ganda."
        : "Terjadi kesalahan saat membuat pembayaran",
      order_id: cleanOrderId
    });

  } finally {
    clearTimeout(timer);
  }
}
      
