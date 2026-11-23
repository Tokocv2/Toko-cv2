
const crypto = require("node:crypto");

export default async function handler(req, res) {
  if (req.method === "GET") {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        success: false,
        message: "Konfigurasi Supabase belum lengkap"
      });
    }

    try {
      const baseUrl = supabaseUrl.replace(/\/+$/, "");

      const response = await fetch(
        `${baseUrl}/rest/v1/orders?select=order_id&limit=0`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
          }
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          message: "Supabase menolak permintaan",
          detail: await response.text()
        });
      }

      return res.status(200).json({
        success: true,
        message: "Koneksi TOKOCV2 ke Supabase berhasil"
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Koneksi Supabase gagal",
        detail: error.message
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Supabase belum lengkap"
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  try {
    // LOGIN OPSIONAL
    let user = null;
    const authHeader = req.headers.authorization;

    if (authHeader) {
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          message: "Format token login tidak valid"
        });
      }

      const accessToken = authHeader.slice(7).trim();

      if (!accessToken) {
        return res.status(401).json({
          success: false,
          message: "Token login kosong"
        });
      }

      const userResponse = await fetch(
        `${baseUrl}/auth/v1/user`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (!userResponse.ok) {
        return res.status(401).json({
          success: false,
          message: "Sesi login tidak valid"
        });
      }

      user = await userResponse.json();

      if (!user.id) {
        return res.status(401).json({
          success: false,
          message: "Pengguna tidak ditemukan"
        });
      }
    }

    // VALIDASI PESANAN
    const {
      sku,
      player_id,
      player_server,
      game
    } = req.body || {};

    if (
      typeof sku !== "string" ||
      !sku.trim() ||
      typeof player_id !== "string" ||
      !/^[0-9]{5,30}$/.test(player_id.trim()) ||
      typeof game !== "string" ||
      !game.trim() ||
      (
        player_server !== undefined &&
        player_server !== null &&
        typeof player_server !== "string"
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Data pesanan tidak lengkap atau tidak valid"
      });
    }

    // AMBIL DAFTAR PRODUK
    const productsResponse = await fetch(
      "https://toko-cv2.vercel.app/api/products",
      { cache: "no-store" }
    );

    const productsText = await productsResponse.text();

    if (!productsResponse.ok) {
      return res.status(503).json({
        success: false,
        message: "Daftar produk belum tersedia",
        detail: productsText.slice(0, 1000)
      });
    }

    let productsResult;

    try {
      productsResult = JSON.parse(productsText);
    } catch {
      return res.status(503).json({
        success: false,
        message: "Respons produk bukan JSON yang valid"
      });
    }

    if (!Array.isArray(productsResult.data)) {
      return res.status(503).json({
        success: false,
        message: "Data produk tidak valid"
      });
    }

    // CARI SKU
    const product = productsResult.data.find(
      p => p.buyer_sku_code === sku.trim()
    );

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Produk tidak ditemukan"
      });
    }

    // HITUNG HARGA JUAL 13%
    const modal = Number(product.price);

    if (!Number.isSafeInteger(modal) || modal <= 0) {
      return res.status(400).json({
        success: false,
        message: "Harga modal tidak valid"
      });
    }

    const hargaJual = Math.round(modal * 1.13);
    const untung = hargaJual - modal;

    // BUAT ID PESANAN
    const orderId = "TCV2-" + crypto.randomUUID();

    const playerId = player_id.trim();
    const playerServer = (player_server || "").trim();

    const customerNo = playerServer
      ? `${playerId}|${playerServer}`
      : playerId;

    // SIMPAN PESANAN KE SUPABASE
    const saveResponse = await fetch(
      `${baseUrl}/rest/v1/orders`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          user_id: user ? user.id : null,
          order_id: orderId,
          customer_no: customerNo,
          player_id: playerId,
          player_server: playerServer || null,
          sku: product.buyer_sku_code,
          product_name: product.product_name,
          modal,
          selling_price: hargaJual,
          profit: untung,
          payment_status: "pending",
          topup_status: "pending"
        })
      }
    );

    const saveText = await saveResponse.text();

    if (!saveResponse.ok) {
      console.error("SUPABASE_SAVE_ORDER_ERROR:", saveText);

      return res.status(500).json({
        success: false,
        message: "Gagal menyimpan pesanan"
      });
    }

    // PESANAN BERHASIL DIBUAT.
    // TAGIHAN QRIS AKAN DIBUAT OLEH create-payment.js.
    return res.status(201).json({
      success: true,
      message: "Pesanan berhasil dibuat",
      order_id: orderId,
      product_name: product.product_name,
      sku: product.buyer_sku_code,
      customer_no: customerNo,
      selling_price: hargaJual,
      payment_status: "pending",
      topup_status: "pending",
      customer_type: user ? "registered" : "guest"
    });

  } catch (error) {
    console.error("ORDERS_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pesanan"
    });
  }
}
    
