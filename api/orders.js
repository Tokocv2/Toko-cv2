
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

  // TES KONEKSI SUPABASE
  if (req.method === "GET") {
    try {
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
        const detail = await response.text();

        console.error("SUPABASE_CONNECTION_ERROR:", detail);

        return res.status(response.status).json({
          success: false,
          message: "Supabase menolak permintaan",
          detail
        });
      }

      return res.status(200).json({
        success: true,
        message: "Koneksi TOKOCV2 ke Supabase berhasil"
      });

    } catch (error) {
      console.error("SUPABASE_CONNECTION_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Koneksi Supabase gagal",
        detail: error.message
      });
    }
  }

  // SIMPAN PESANAN
  if (req.method === "POST") {
    try {
      // LOGIN OPSIONAL / GUEST
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
            message: "Sesi login tidak valid. Silakan login kembali."
          });
        }

        user = await userResponse.json();
      }

      // VALIDASI DATA PESANAN
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

      // AMBIL DAFTAR PRODUK DIGIFLAZZ
      const vercelUrl = process.env.VERCEL_URL;

      if (!vercelUrl) {
        return res.status(500).json({
          success: false,
          message: "Konfigurasi URL produk belum tersedia"
        });
      }

      const productsResponse = await fetch(
        `https://${vercelUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/products`,
        {
          cache: "no-store"
        }
      );

      if (!productsResponse.ok) {
        const detail = await productsResponse.text();

        console.error("PRODUCT_FETCH_ERROR:", detail);

        return res.status(503).json({
          success: false,
          message: "Daftar produk belum tersedia",
          detail
        });
      }

      const productsResult = await productsResponse.json();

      if (!Array.isArray(productsResult.data)) {
        console.error(
          "INVALID_PRODUCT_DATA:",
          productsResult
        );

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

      // VALIDASI HARGA MODAL
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

      // BUAT ID PESANAN
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
            user_id: user ? user.id : null,
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

      // BACA HASIL SUPABASE
      const saveText = await saveResponse.text();

      let savedData;

      try {
        savedData = saveText ? JSON.parse(saveText) : null;
      } catch {
        savedData = saveText;
      }

      if (!saveResponse.ok) {
        console.error(
          "SUPABASE_INSERT_ERROR:",
          savedData
        );

        return res.status(500).json({
          success: false,
          message: "Gagal menyimpan pesanan",
          detail: savedData
        });
      }

      // PESANAN BERHASIL DISIMPAN
      return res.status(201).json({
        success: true,
        message: "Pesanan berhasil disimpan",
        order_id: orderId,
        product_name: product.product_name,
        selling_price: hargaJual,
        payment_status: "pending",
        topup_status: "pending",
        customer_type: user ? "registered" : "guest"
      });

    } catch (error) {
      // CATAT ERROR UNTUK PEMERIKSAAN VERCEL
      console.error("ORDERS_ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Terjadi kesalahan saat membuat pesanan",
        detail: error.message
      });
    }
  }

  // METODE SELAIN GET DAN POST DITOLAK
  return res.status(405).json({
    success: false,
    message: "Method not allowed"
  });
}
