import crypto from "node:crypto";

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

// VALIDASI URL SNAP V2, V3, DAN V4
function validateSnapRedirectUrl(value, mode) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsedUrl = new URL(value);

    const allowedHost =
      mode === "production"
        ? "app.midtrans.com"
        : "app.sandbox.midtrans.com";

    const allowedPath =
      /^\/snap\/(?:v2\/vtweb|v3\/redirection|v4\/redirection)\/[A-Za-z0-9-]+\/?$/;

    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== allowedHost ||
      parsedUrl.port ||
      parsedUrl.username ||
      parsedUrl.password ||
      !allowedPath.test(parsedUrl.pathname)
    ) {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    MIDTRANS_MODE = "sandbox",
    MIDTRANS_SERVER_KEY
  } = process.env;

  const mode = String(MIDTRANS_MODE).trim().toLowerCase();
  const serverKey = String(MIDTRANS_SERVER_KEY || "").trim();

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

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !serverKey) {
    return res.status(500).json({
      success: false,
      message: "Environment Variables belum lengkap"
    });
  }

  const keyValid =
    mode === "sandbox"
      ? serverKey.startsWith("SB-Mid-server-")
      : serverKey.startsWith("Mid-server-");

  if (!keyValid) {
    return res.status(500).json({
      success: false,
      message: "Server Key tidak sesuai dengan mode Midtrans"
    });
  }

  const {
    order_id,
    sku,
    customer_no,
    guest_access_token
  } = req.body || {};

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
    cleanOrderId.length > 50 ||
    !/^[A-Za-z0-9._~-]+$/.test(cleanOrderId) ||
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

      const rows = await response.json();

      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error("Pengunci pembayaran gagal diverifikasi");
      }

      lockClaimed = false;
    } finally {
      clearTimeout(releaseTimer);
    }
  }

  try {
    // VERIFIKASI LOGIN OPSIONAL
    let user = null;

    const authorization = req.headers.authorization;

    if (authorization) {
      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          message: "Format token login tidak valid"
        });
      }

      const loginToken = authorization.slice(7).trim();

      if (!loginToken) {
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
            Authorization: `Bearer ${loginToken}`
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

    // TOKEN WAJIB UNTUK PEMBELI TAMU
    if (!user) {
      if (
        typeof guest_access_token !== "string" ||
        guest_access_token.length < 20 ||
        guest_access_token.length > 200
      ) {
        return res.status(401).json({
          success: false,
          message: "Token akses pesanan tamu tidak valid"
        });
      }
    }

    // AMBIL PESANAN MILIK PEMBELI
    const params = new URLSearchParams({
      select:
        "order_id,user_id,guest_access_token_hash,sku,customer_no,product_name,selling_price,payment_status,payment_creation_status",
      order_id: `eq.${cleanOrderId}`,
      limit: "1"
    });

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

    // VERIFIKASI SHA-256 TOKEN TAMU
    if (!user) {
      const storedHash = order.guest_access_token_hash;

      const suppliedHash = crypto
        .createHash("sha256")
        .update(guest_access_token, "utf8")
        .digest("hex");

      if (
        typeof storedHash !== "string" ||
        !/^[a-f0-9]{64}$/i.test(storedHash) ||
        !safeEqual(suppliedHash, storedHash.toLowerCase())
      ) {
        return res.status(404).json({
          success: false,
          message: "Pesanan tidak ditemukan"
        });
      }
    }

    // VALIDASI DATA PESANAN
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
          "Pembayaran sudah diproses. Jangan membuat tagihan baru.",
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

    // MIDTRANS SNAP
    const snapUrl =
      mode === "production"
        ? "https://app.midtrans.com/snap/v1/transactions"
        : "https://app.sandbox.midtrans.com/snap/v1/transactions";

    const auth = Buffer.from(`${serverKey}:`).toString("base64");

    midtransRequestStarted = true;

    const snapResponse = await fetch(snapUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: order.order_id,
          gross_amount: amount
        },
        item_details: [
          {
            id: cleanSku,
            price: amount,
            quantity: 1,
            name: String(order.product_name || cleanSku).slice(0, 50)
          }
        ],
        credit_card: {
          secure: true
        }
      }),
      signal: controller.signal
    });

    let payment;

    try {
      payment = await snapResponse.json();
    } catch {
      throw new Error("Respons Snap Midtrans tidak dapat dibaca");
    }

    // PENOLAKAN MIDTRANS
    if (!snapResponse.ok) {
      console.error("MIDTRANS_SNAP_ERROR:", {
        httpStatus: snapResponse.status,
        response: payment
      });

      if (snapResponse.status >= 500) {
        return res.status(502).json({
          success: false,
          uncertain: true,
          message:
            "Midtrans mengalami gangguan. Jangan membuat tagihan baru sebelum status diperiksa.",
          order_id: cleanOrderId
        });
      }

      await releaseLock();

      return res.status(400).json({
        success: false,
        message:
          payment?.error_messages?.join(", ") ||
          payment?.status_message ||
          "Midtrans menolak pembuatan pembayaran"
      });
    }

    // VALIDASI TOKEN DAN URL CHECKOUT
    const redirectUrl = validateSnapRedirectUrl(
      payment?.redirect_url,
      mode
    );

    if (
      snapResponse.status !== 201 ||
      typeof payment?.token !== "string" ||
      !payment.token.trim() ||
      !redirectUrl
    ) {
      let urlInfo = null;

      try {
        const parsed = new URL(payment?.redirect_url);

        urlInfo = {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          pathname: parsed.pathname
        };
      } catch {
        urlInfo = "URL tidak valid";
      }

      console.error("MIDTRANS_SNAP_INVALID_RESPONSE:", {
        orderId: cleanOrderId,
        httpStatus: snapResponse.status,
        tokenType: typeof payment?.token,
        tokenLength: payment?.token?.length || 0,
        redirectUrl: urlInfo,
        redirectAccepted: Boolean(redirectUrl)
      });

      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Respons pembayaran Midtrans belum lengkap. Jangan membuat tagihan baru sebelum diperiksa.",
        order_id: cleanOrderId
      });
    }

    // SIMPAN URL CHECKOUT
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
          payment_url: redirectUrl
        }),
        signal: controller.signal
      }
    );

    if (!updateResponse.ok) {
      console.error(
        "PAYMENT_STATUS_SAVE_ERROR:",
        await updateResponse.text()
      );

      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Checkout Midtrans mungkin sudah dibuat, tetapi penyimpanan status internal gagal.",
        order_id: cleanOrderId
      });
    }

    const updatedOrders = await updateResponse.json();

    if (
      !Array.isArray(updatedOrders) ||
      updatedOrders.length !== 1
    ) {
      console.error(
        "PAYMENT_STATUS_SAVE_UNVERIFIED:",
        cleanOrderId
      );

      return res.status(502).json({
        success: false,
        uncertain: true,
        message:
          "Checkout mungkin sudah dibuat, tetapi status pesanan belum berhasil diverifikasi.",
        order_id: cleanOrderId
      });
    }

    lockClaimed = false;

    return res.status(200).json({
      success: true,
      mode,
      message: "Checkout Midtrans berhasil dibuat",
      order_id: cleanOrderId,
      payment: {
        token: payment.token,
        redirect_url: redirectUrl,
        payment_url: redirectUrl
      }
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
          ? "Respons Midtrans timeout. Jangan membuat tagihan baru sebelum status diperiksa."
          : "Permintaan timeout sebelum hasil pembayaran dapat dipastikan.",
        order_id: cleanOrderId
      });
    }

    return res.status(500).json({
      success: false,
      uncertain: lockClaimed,
      message: lockClaimed
        ? "Proses pembayaran belum dapat dipastikan. Pengunci dipertahankan untuk mencegah tagihan ganda."
        : "Terjadi kesalahan saat membuat pembayaran",
      order_id: cleanOrderId
    });

  } finally {
    clearTimeout(timer);
  }
}
          
