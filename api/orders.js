
export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  const midtransServerKey = (
    process.env.MIDTRANS_SERVER_KEY || ""
  ).trim();

  const PRODUCTS_URL =
    "https://toko-cv2.vercel.app/api/products";

  const MIDTRANS_URL =
    "https://app.sandbox.midtrans.com/snap/v1/transactions";

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

  let currentStep = "memulai pesanan";
  let orderId = null;
  let orderSaved = false;
  let snapCreated = false;

  // Mengubah status pembayaran jika tagihan gagal dibuat
  async function markPaymentFailed() {
    if (!orderId || !orderSaved || snapCreated) {
      return;
    }

    try {
      const response = await fetch(
        `${baseUrl}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&payment_status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            payment_status: "failed"
          })
        }
      );

      const result = await response.text();

      if (!response.ok) {
        throw new Error(result);
      }

      console.log("PAYMENT_FAILED_UPDATE:", {
        orderId,
        updatedRows: result ? JSON.parse(result).length : 0
      });
    } catch (error) {
      console.error("PAYMENT_FAILED_UPDATE_ERROR:", {
        orderId,
        message: error.message
      });
    }
  }

  try {
    if (!midtransServerKey) {
      return res.status(500).json({
        success: false,
        message: "MIDTRANS_SERVER_KEY belum tersedia"
      });
    }

    // LOGIN OPSIONAL
    currentStep = "memeriksa login";

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
    }

    // VALIDASI PESANAN
    currentStep = "memvalidasi data pesanan";

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

    // MENGAMBIL PRODUK
    currentStep = "mengambil daftar produk";

    const productsResponse = await fetch(PRODUCTS_URL, {
      cache: "no-store"
    });

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

    // MENCARI SKU
    currentStep = "mencari produk";

    const product = productsResult.data.find(
      p => p.buyer_sku_code === sku.trim()
    );

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Produk tidak ditemukan"
      });
    }

    // MENGHITUNG HARGA
    currentStep = "menghitung harga";

    const modal = Number(product.price);

    if (!Number.isFinite(modal) || modal <= 0) {
      return res.status(400).json({
        success: false,
        message: "Harga modal tidak valid"
      });
    }

    const hargaJual = Math.round(modal * 1.13);
    const untung = hargaJual - modal;

    // MEMBUAT ID PESANAN
    currentStep = "membuat ID pesanan";

    const crypto = await import("node:crypto");
    orderId = "TCV2-" + crypto.randomUUID();

    const playerId = player_id.trim();
    const playerServer = (player_server || "").trim();

    const customerNo = playerServer
      ? `${playerId}|${playerServer}`
      : playerId;

    // MENYIMPAN PESANAN KE SUPABASE
    currentStep = "menyimpan pesanan ke Supabase";

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

    const saveText = await saveResponse.text();

    if (!saveResponse.ok) {
      return res.status(500).json({
        success: false,
        message: "Gagal menyimpan pesanan",
        detail: saveText
      });
    }

    orderSaved = true;

    // MEMBUAT TAGIHAN MIDTRANS SANDBOX
    currentStep = "membuat tagihan Midtrans";

    const authorization = Buffer
      .from(`${midtransServerKey}:`)
      .toString("base64");

    const snapResponse = await fetch(MIDTRANS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${authorization}`
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: orderId,
          gross_amount: hargaJual
        },
        item_details: [
          {
            id: String(product.buyer_sku_code).slice(0, 50),
            price: hargaJual,
            quantity: 1,
            name: String(
              product.product_name || game
            ).slice(0, 50)
          }
        ]
      })
    });

    const snapText = await snapResponse.text();

    let snapData;

    try {
      snapData = JSON.parse(snapText);
    } catch {
      snapData = {
        message: snapText
      };
    }

    if (
      !snapResponse.ok ||
      !snapData.token ||
      !snapData.redirect_url
    ) {
      console.error("MIDTRANS_ERROR:", {
        status: snapResponse.status,
        response: snapData
      });

      await markPaymentFailed();

      return res.status(502).json({
        success: false,
        message: "Midtrans gagal membuat tagihan",
        order_id: orderId,
        detail: snapData
      });
    }

    snapCreated = true;

    // MENYIMPAN TOKEN DAN TAUTAN PEMBAYARAN
    currentStep = "menyimpan data pembayaran";

    const updateResponse = await fetch(
      `${baseUrl}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          snap_token: snapData.token,
          payment_url: snapData.redirect_url
        })
      }
    );

    if (!updateResponse.ok) {
      console.error(
        "PAYMENT_SAVE_ERROR:",
        await updateResponse.text()
      );

      // Tagihan sudah dibuat, jadi jangan tandai failed.
      // Tautan tetap dikirim agar pelanggan bisa membayar.
      return res.status(201).json({
        success: true,
        message: "Tagihan berhasil dibuat, tetapi data pembayaran gagal disimpan ke database",
        order_id: orderId,
        product_name: product.product_name,
        selling_price: hargaJual,
        snap_token: snapData.token,
        payment_url: snapData.redirect_url,
        payment_status: "pending",
        topup_status: "pending",
        customer_type: user ? "registered" : "guest",
        warning: "Simpan tautan pembayaran ini"
      });
    }

    // BERHASIL
    return res.status(201).json({
      success: true,
      message: "Pesanan dan tagihan Midtrans berhasil dibuat",
      order_id: orderId,
      product_name: product.product_name,
      selling_price: hargaJual,
      snap_token: snapData.token,
      payment_url: snapData.redirect_url,
      payment_status: "pending",
      topup_status: "pending",
      customer_type: user ? "registered" : "guest"
    });

  } catch (error) {
    console.error("ORDERS_ERROR:", {
      step: currentStep,
      orderId,
      message: error.message,
      stack: error.stack
    });

    // Jika pesanan sudah tersimpan tetapi tagihan gagal dibuat,
    // tandai pembayaran sebagai gagal.
    await markPaymentFailed();

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pesanan",
      step: currentStep,
      order_id: orderId,
      detail: error.message
    });
  }
}
