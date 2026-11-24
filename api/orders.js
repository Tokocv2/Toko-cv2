
import crypto from "node:crypto";

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

  const supabaseHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  // DIAGNOSTIK KONEKSI SUPABASE
  if (req.method === "GET") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(
        `${baseUrl}/rest/v1/orders?select=order_id&limit=0`,
        {
          method: "GET",
          headers: supabaseHeaders,
          signal: controller.signal,
          cache: "no-store"
        }
      );

      if (!response.ok) {
        console.error(
          "ORDERS_HEALTH_ERROR:",
          response.status,
          await response.text()
        );

        return res.status(503).json({
          success: false,
          message: "Koneksi Supabase belum berhasil"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Koneksi TOKOCV2 ke Supabase berhasil"
      });

    } catch (error) {
      console.error("ORDERS_HEALTH_ERROR:", error.message);

      return res.status(500).json({
        success: false,
        message: "Koneksi Supabase gagal"
      });

    } finally {
      clearTimeout(timer);
    }
  }

  // HANYA POST UNTUK MEMBUAT PESANAN
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    // LOGIN OPSIONAL
    let user = null;

    const authHeader = req.headers.authorization;

    if (authHeader) {
      if (
        typeof authHeader !== "string" ||
        !authHeader.startsWith("Bearer ")
      ) {
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
          method: "GET",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
          },
          signal: controller.signal
        }
      );

      if (!userResponse.ok) {
        return res.status(401).json({
          success: false,
          message: "Sesi login tidak valid"
        });
      }

      user = await userResponse.json();

      if (!user || typeof user.id !== "string" || !user.id) {
        return res.status(401).json({
          success: false,
          message: "Identitas pengguna tidak valid"
        });
      }
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
      sku.trim().length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: "SKU produk tidak valid"
      });
    }

    // ID / NOMOR TUJUAN WAJIB UNTUK SEMUA PRODUK
    if (
      typeof player_id !== "string" ||
      !player_id.trim() ||
      player_id.trim().length > 100 ||
      /[\u0000-\u001F\u007F|]/.test(player_id)
    ) {
      return res.status(400).json({
        success: false,
        message: "ID atau nomor tujuan wajib diisi dengan benar"
      });
    }

    // SERVER / ZONE ID OPSIONAL
    if (
      player_server !== undefined &&
      player_server !== null &&
      (
        typeof player_server !== "string" ||
        player_server.length > 50 ||
        /[\u0000-\u001F\u007F|]/.test(player_server)
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Server atau Zone ID tidak valid"
      });
    }

    // NAMA GAME OPSIONAL UNTUK PRODUK DIGITAL
    if (
      game !== undefined &&
      game !== null &&
      (
        typeof game !== "string" ||
        game.length > 100 ||
        /[\u0000-\u001F\u007F]/.test(game)
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Data game tidak valid"
      });
    }

    const cleanSku = sku.trim();
    const playerId = player_id.trim();
    const playerServer = (player_server || "").trim();
    const gameName = (game || "").trim();

    // NOMOR TUJUAN UNTUK DIGIFLAZZ
    const customerNo = playerServer
      ? `${playerId}|${playerServer}`
      : playerId;

    if (customerNo.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Nomor tujuan terlalu panjang"
      });
    }

    // AMBIL DAFTAR PRODUK
    const productsResponse = await fetch(
      "https://toko-cv2.vercel.app/api/products",
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (!productsResponse.ok) {
      const detail = await productsResponse.text();

      console.error("ORDERS_PRODUCTS_ERROR:", {
        status: productsResponse.status,
        detail: detail.slice(0, 1000)
      });

      return res.status(503).json({
        success: false,
        message: "Daftar produk belum tersedia"
      });
    }

    let productsResult;

    try {
      productsResult = await productsResponse.json();
    } catch {
      return res.status(503).json({
        success: false,
        message: "Respons daftar produk tidak valid"
      });
    }

    if (!Array.isArray(productsResult?.data)) {
      console.error("ORDERS_PRODUCTS_INVALID_DATA");

      return res.status(503).json({
        success: false,
        message: "Data produk tidak valid"
      });
    }

    // CARI SKU PRODUK
    const product = productsResult.data.find(
      item =>
        item &&
        item.buyer_sku_code === cleanSku
    );

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Produk tidak ditemukan"
      });
    }

    // VALIDASI HARGA MODAL
    const modal = Number(product.price);

    if (
      !Number.isSafeInteger(modal) ||
      modal <= 0
    ) {
      console.error("ORDERS_INVALID_PRODUCT_PRICE:", cleanSku);

      return res.status(400).json({
        success: false,
        message: "Harga modal produk tidak valid"
      });
    }

    // HITUNG HARGA JUAL DENGAN MARKUP 13%
    const hargaJual = Math.round(modal * 1.13);
    const untung = hargaJual - modal;

    if (
      !Number.isSafeInteger(hargaJual) ||
      hargaJual <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Harga jual tidak valid"
      });
    }

    // BUAT ID PESANAN UNIK
    const orderId = `TCV2-${crypto.randomUUID()}`;

    const productName =
      typeof product.product_name === "string" &&
      product.product_name.trim()
        ? product.product_name.trim()
        : cleanSku;

    // SIMPAN PESANAN KE SUPABASE
    const saveResponse = await fetch(
      `${baseUrl}/rest/v1/orders`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          user_id: user ? user.id : null,
          order_id: orderId,
          customer_no: customerNo,
          player_id: playerId,
          player_server: playerServer || null,
          sku: cleanSku,
          product_name: productName,
          modal: modal,
          selling_price: hargaJual,
          profit: untung,

          // STATUS AWAL PESANAN
          payment_status: "pending",
          payment_creation_status: "idle",
          topup_status: "pending"
        }),
        signal: controller.signal
      }
    );

    const saveText = await saveResponse.text();

    if (!saveResponse.ok) {
      console.error("SUPABASE_SAVE_ORDER_ERROR:", {
        status: saveResponse.status,
        detail: saveText.slice(0, 1500)
      });

      return res.status(500).json({
        success: false,
        message: "Gagal menyimpan pesanan"
      });
    }

    let savedOrders;

    try {
      savedOrders = JSON.parse(saveText);
    } catch {
      console.error("SUPABASE_SAVE_ORDER_INVALID_RESPONSE");

      return res.status(500).json({
        success: false,
        message: "Respons penyimpanan pesanan tidak valid"
      });
    }

    if (
      !Array.isArray(savedOrders) ||
      savedOrders.length !== 1 ||
      savedOrders[0].order_id !== orderId
    ) {
      console.error("SUPABASE_SAVE_ORDER_UNVERIFIED:", orderId);

      return res.status(500).json({
        success: false,
        message: "Penyimpanan pesanan belum berhasil diverifikasi"
      });
    }

    // PESANAN BERHASIL DIBUAT
    // QRIS AKAN DIBUAT OLEH api/create-payment.js
    return res.status(201).json({
      success: true,
      message: "Pesanan berhasil dibuat",
      order_id: orderId,
      product_name: productName,
      sku: cleanSku,
      customer_no: customerNo,
      selling_price: hargaJual,
      payment_status: "pending",
      payment_creation_status: "idle",
      topup_status: "pending",
      customer_type: user ? "registered" : "guest"
    });

  } catch (error) {
    console.error("ORDERS_ERROR:", {
      message: error.message,
      name: error.name
    });

    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError"
    ) {
      return res.status(504).json({
        success: false,
        message: "Permintaan pembuatan pesanan timeout"
      });
    }

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pesanan"
    });

  } finally {
    clearTimeout(timer);
  }
        }
        
