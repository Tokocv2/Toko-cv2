
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!supabaseUrl || !supabaseKey || !serverKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Supabase atau Midtrans belum lengkap"
    });
  }

  const token = (req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Silakan login terlebih dahulu"
    });
  }

  const { order_id, sku, customer_no } = req.body || {};

  const validCustomerNo =
    typeof customer_no === "string" &&
    /^(?:[0-9]{5,30})(?:\|[0-9]{1,20})?$/.test(customer_no);

  if (
    typeof order_id !== "string" ||
    !/^TCV2-[0-9a-f-]{36}$/i.test(order_id) ||
    typeof sku !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(sku) ||
    !validCustomerNo
  ) {
    return res.status(400).json({
      success: false,
      message: "Data pesanan tidak valid"
    });
  }

  try {
    const baseUrl = supabaseUrl.replace(/\/+$/, "");

    // 1. VERIFIKASI LOGIN PEMBELI
    const userResponse = await fetch(
      `${baseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        success: false,
        message: "Sesi login tidak valid"
      });
    }

    const user = await userResponse.json();

    if (!user.id) {
      return res.status(401).json({
        success: false,
        message: "Pengguna tidak ditemukan"
      });
    }

    // 2. AMBIL ORDER MILIK PENGGUNA DARI SUPABASE
    const query = new URLSearchParams({
      select: "order_id,user_id,sku,customer_no,product_name,selling_price,payment_status",
      order_id: `eq.${order_id}`,
      user_id: `eq.${user.id}`,
      limit: "1"
    });

    const orderResponse = await fetch(
      `${baseUrl}/rest/v1/orders?${query.toString()}`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!orderResponse.ok) {
      console.error("Supabase order error:", await orderResponse.text());

      return res.status(502).json({
        success: false,
        message: "Gagal memeriksa pesanan"
      });
    }

    const orders = await orderResponse.json();
    const order = orders[0];

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Pesanan tidak ditemukan"
      });
    }

    // 3. COCOKKAN DATA PESANAN
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
        message: "Pesanan sudah dibayar atau tidak dapat dibayar"
      });
    }

    // 4. AMBIL HARGA JUAL ASLI DARI SUPABASE
    const hargaJual = Number(order.selling_price);

    if (
      !Number.isSafeInteger(hargaJual) ||
      hargaJual <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Nominal pesanan tidak valid"
      });
    }

    // 5. BUAT TAGIHAN MIDTRANS SANDBOX
    const auth = Buffer
      .from(serverKey + ":")
      .toString("base64");

    const midtransResponse = await fetch(
      "https://api.sandbox.midtrans.com/v2/charge",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${auth}`
        },
        body: JSON.stringify({
          payment_type: "qris",
          transaction_details: {
            order_id: order.order_id,
            gross_amount: hargaJual
          },
          item_details: [
            {
              id: order.sku,
              price: hargaJual,
              quantity: 1,
              name: String(
                order.product_name || order.sku
              ).slice(0, 50)
            }
          ],
          custom_field1: order.customer_no
        })
      }
    );

    const payment = await midtransResponse.json();

    if (!midtransResponse.ok) {
      console.error("Midtrans error:", payment);

      return res.status(502).json({
        success: false,
        message: "Gagal membuat tagihan Midtrans",
        detail:
          payment.status_message ||
          payment.message ||
          "Kesalahan pembayaran"
      });
    }

    // 6. KEMBALIKAN INFORMASI PEMBAYARAN
    return res.status(200).json({
      success: true,
      order_id: order.order_id,
      product_name: order.product_name,
      amount: hargaJual,
      payment: payment
    });

  } catch (error) {
    console.error("Create payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pembayaran"
    });
  }
         }
        
