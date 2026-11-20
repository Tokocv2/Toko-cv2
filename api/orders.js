export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Supabase belum lengkap"
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  // TES KONEKSI
  if (req.method === "GET") {
    try {
      const response = await fetch(
        `${baseUrl}/rest/v1/orders?select=id&limit=0`,
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
        message: "Koneksi Supabase gagal"
      });
    }
  }

  // SIMPAN PESANAN
  if (req.method === "POST") {
    try {
      // VERIFIKASI AKUN PELANGGAN
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          message: "Silakan login terlebih dahulu"
        });
      }

      const accessToken = authHeader.slice(7);

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
          message: "Sesi login tidak valid. Silakan login kembali."
        });
      }

      const user = await userResponse.json();

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
        !player_id.trim() ||
        typeof game !== "string" ||
        !game.trim() ||
        (player_server !== undefined &&
          typeof player_server !== "string")
      ) {
        return res.status(400).json({
          success: false,
          message: "Data pesanan tidak lengkap atau tidak valid"
        });
      }

      // AMBIL DAFTAR PRODUK
      if (!process.env.VERCEL_URL) {
        return res.status(500).json({
          success: false,
          message: "Konfigurasi URL produk belum tersedia"
        });
      }

      const productsResponse = await fetch(
        `https://${process.env.VERCEL_URL}/api/products`,
        { cache: "no-store" }
      );

      if (!productsResponse.ok) {
        return res.status(503).json({
          success: false,
          message: "Daftar produk belum tersedia"
        });
      }

      const productsResult = await productsResponse.json();

      if (!Array.isArray(productsResult.data)) {
        return res.status(503).json({
          success: false,
          message: "Data produk tidak valid"
        });
      }

      const product = productsResult.data.find(
        p => p.buyer_sku_code === sku.trim()
      );

      if (!product) {
        return res.status(400).json({
          success: false,
          message: "Produk tidak ditemukan"
        });
      }

      const modal = Number(product.price);

      if (!Number.isFinite(modal) || modal <= 0) {
        return res.status(400).json({
          success: false,
          message: "Harga modal produk tidak valid"
        });
      }

      // HITUNG HARGA JUAL: MARKUP 13%
      const hargaJual = Math.round(modal * 1.13);
      const untung = hargaJual - modal;

      const crypto = await import("node:crypto");
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
            user_id: user.id,
            order_id: orderId,
            customer_no: customerNo,
            player_id: playerId,
            player_server: playerServer || null,
            sku: product.buyer_sku_code,
            product_name: product.product_name,
            modal: modal,
            selling_price: hargaJual,
            profit: untung,
            payment_status: "pending",
            topup_status: "pending"
          })
        }
      );

      const savedData = await saveResponse.json();

      if (!saveResponse.ok) {
        return res.status(500).json({
          success: false,
          message: "Gagal menyimpan pesanan",
          detail: savedData
        });
      }

      return res.status(201).json({
        success: true,
        message: "Pesanan berhasil disimpan",
        order_id: orderId,
        product_name: product.product_name,
        selling_price: hargaJual,
        payment_status: "pending",
        topup_status: "pending"
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Terjadi kesalahan saat membuat pesanan",
        detail: error.message
      });
    }
  }

  return res.status(405).json({
    success: false,
    message: "Method not allowed"
  });
  }

