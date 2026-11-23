
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false });
  }

  try {
    const secret = process.env.DIGIFLAZZ_RECOVERY_SECRET;
    const supplied = req.headers["x-recovery-secret"];

    if (!secret || supplied !== secret) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    const url =
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/orders` +
      `?orders_id=eq.36` +
      `&order_id=eq.TCV2-c308d729-b08d-4e14-ab65-042560f8cb05` +
      `&topup_status=eq.retrying`;

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        topup_status: "success"
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(JSON.stringify(result));
    }

    return res.status(200).json({
      success: true,
      message: result.length
        ? "Order 36 berhasil diperbarui"
        : "Order 36 tidak berubah; periksa statusnya",
      updated_rows: result.length
    });

  } catch (error) {
    console.error("FINALIZE_ORDER_36_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal memperbarui order"
    });
  }
}
