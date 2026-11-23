
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

  try {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !MIDTRANS_SERVER_KEY) {
      throw new Error("Environment Variables belum lengkap");
    }

    const mode = MIDTRANS_MODE.toLowerCase();

    if (!["sandbox", "production"].includes(mode)) {
      throw new Error("MIDTRANS_MODE harus sandbox atau production");
    }

    const {
      order_id,
      sku,
      customer_no
    } = req.body || {};

    if (!order_id || !sku || !customer_no) {
      return res.status(400).json({
        success: false,
        message: "Data transaksi belum lengkap"
      });
    }

    const supabaseUrl = SUPABASE_URL.replace(/\/+$/, "");

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    // Login bersifat opsional.
    // Jika token tersedia, validasi pemilik akun.
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
          }
        }
      );

      if (!authResponse.ok) {
        return res.status(401).json({
          success: false,
          message: "Token login tidak valid"
        });
      }

      user = await authResponse.json();
    }

    // Cari pesanan berdasarkan order ID.
    const params = new URLSearchParams({
      select: "order_id,user_id,sku,customer_no,product_name,selling_price,payment_status",
      order_id: `eq.${order_id}`,
      limit: "1"
    });

    // Pesanan akun harus cocok dengan pemiliknya.
    // Pesanan tamu harus memiliki user_id NULL.
    if (user) {
      params.set("user_id", `eq.${user.id}`);
    } else {
      params.set("user_id", "is.null");
    }

    const orderResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?${params.toString()}`,
      { headers }
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
      return res.status(400).json({
        success: false,
        message: "Pesanan bukan berstatus pending"
      });
    }

    const amount = Number(order.selling_price);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Nominal pembayaran tidak valid");
    }

    // URL otomatis mengikuti MIDTRANS_MODE.
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
          gross_amount: Math.round(amount)
        },
        qris: {
          acquirer: "gopay"
        },
        item_details: [
          {
            id: order.sku,
            price: Math.round(amount),
            quantity: 1,
            name: order.product_name || order.sku
          }
        ]
      })
    });

    const payment = await midtransResponse.json();

    if (!midtransResponse.ok) {
      console.error("Midtrans error:", payment);

      return res.status(400).json({
        success: false,
        message:
          payment.status_message ||
          "Gagal membuat pembayaran QRIS",
        midtrans: payment
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
    console.error("Create payment error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Terjadi kesalahan server"
    });
  }
}
