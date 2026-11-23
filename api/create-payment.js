export default async function handler(req, res) {
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

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY ||
    !MIDTRANS_SERVER_KEY
  ) {
    return res.status(500).json({
      success: false,
      message: "Environment Variables belum lengkap"
    });
  }

  const mode = String(MIDTRANS_MODE).toLowerCase();

  if (!["sandbox", "production"].includes(mode)) {
    return res.status(500).json({
      success: false,
      message: "MIDTRANS_MODE harus sandbox atau production"
    });
  }

  const {
    order_id,
    sku,
    customer_no
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const supabaseUrl = SUPABASE_URL.replace(/\/+$/, "");

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    // LOGIN OPSIONAL
    let user = null;
    const authorization = req.headers.authorization;

    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice(7);

      const authResponse = await fetch(
        `${supabaseUrl}/auth/v1/user`,
        {
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
      select: "order_id,user_id,sku,customer_no,product_name,selling_price,payment_status",
      order_id: `eq.${order_id}`,
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
      order.sku !== sku ||
      order.customer_no !== customer_no
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

    const amount = Number(order.selling_price);

    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Nominal pembayaran tidak valid"
      });
    }

    // MIDTRANS SANDBOX / PRODUCTION
    const midtransUrl =
      mode === "production"
        ? "https://api.midtrans.com/v2/charge"
        : "https://api.sandbox.midtrans.com/v2/charge";

    const auth = Buffer.from(
      `${MIDTRANS_SERVER_KEY}:`
    ).toString("base64");

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
      throw new Error("Respons Midtrans tidak valid");
    }

    if (!midtransResponse.ok) {
      console.error("MIDTRANS_CREATE_ERROR:", payment);

      return res.status(400).json({
        success: false,
        message:
          payment.status_message ||
          "Gagal membuat pembayaran QRIS"
      });
    }

    return res.status(200).json({
      success: true,
      mode,
      message: "Pembayaran QRIS berhasil dibuat",
      order_id: order.order_id,
      payment
    });

  } catch (error) {
    console.error(
      "CREATE_PAYMENT_ERROR:",
      error.message
    );

    if (error.name === "AbortError") {
      return res.status(504).json({
        success: false,
        uncertain: true,
        message: "Respons server timeout. Status pembayaran perlu diperiksa sebelum mencoba kembali.",
        order_id
      });
    }

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pembayaran"
    });

  } finally {
    clearTimeout(timer);
  }
}

