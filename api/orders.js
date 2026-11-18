
export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Supabase belum lengkap"
    });
  }

  // Tes koneksi Supabase
  if (req.method === "GET") {
    try {
      const response = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/orders?select=orders_id&limit=0`,
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

  // Simpan pesanan
  if (req.method === "POST") {
    const {
      order_id,
      customer_no,
      sku,
      product_name,
      modal,
      selling_price
    } = req.body || {};

    if (
      !order_id ||
      !customer_no ||
      !sku ||
      !product_name ||
      modal === undefined ||
      selling_price === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Data pesanan belum lengkap"
      });
    }

    const modalValue = Number(modal);
    const sellingValue = Number(selling_price);

    if (
      !Number.isFinite(modalValue) ||
      !Number.isFinite(sellingValue) ||
      modalValue < 0 ||
      sellingValue < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Harga pesanan tidak valid"
      });
    }

    try {
      const response = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/orders`,
        {
          method: "POST",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            order_id,
            customer_no,
            sku,
            product_name,
            modal: modalValue,
            selling_price: sellingValue,
            profit: sellingValue - modalValue,
            payment_status: "pending",
            topup_status: "pending"
          })
        }
      );

      const result = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          message: "Gagal menyimpan pesanan",
          detail: result
        });
      }

      return res.status(201).json({
        success: true,
        message: "Pesanan berhasil disimpan",
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Gagal menyimpan pesanan",
        detail: error.message
      });
    }
  }

  return res.status(405).json({
    success: false,
    message: "Method not allowed"
  });
}
