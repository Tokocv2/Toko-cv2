
export default async function handler(req, res) {
  if (req.method !== "GET") {
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

  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/orders?select=orders_id&limit=0`,
      {
        method: "GET",
        headers: {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!response.ok) {
  const errorText = await response.text();

  return res.status(response.status).json({
    success: false,
    message: "Supabase menolak permintaan",
    status: response.status,
    detail: errorText
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
