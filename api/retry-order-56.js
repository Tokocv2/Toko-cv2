
const sendDigiflazz = require("../lib/digiflazz");
const crypto = require("node:crypto");

const ORDER_ID = "TCV2-877b4309-f52e-4cb2-b754-cd0df5fe912f";

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));

  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const secret = process.env.DIGIFLAZZ_RECOVERY_SECRET;
  const supplied = req.headers["x-recovery-secret"];

  console.log("ORDER56_AUTH_CHECK", {
    secretConfigured: Boolean(secret),
    headerPresent: Boolean(supplied),
    secretLength: secret ? secret.length : 0,
    headerLength: supplied ? String(supplied).length : 0
  });

  if (!secret || !safeEqual(supplied, secret)) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
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

  const base = supabaseUrl.replace(/\/+$/, "");

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  try {
    const claimUrl =
      `${base}/rest/v1/orders` +
      `?order_id=eq.${encodeURIComponent(ORDER_ID)}` +
      `&orders_id=eq.56` +
      `&payment_status=eq.paid` +
      `&topup_status=eq.pending`;

    const claimResponse = await fetch(claimUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        topup_status: "processing"
      })
    });

    const claimText = await claimResponse.text();

    if (!claimResponse.ok) {
      throw new Error("Gagal mengunci order: " + claimText);
    }

    const rows = claimText ? JSON.parse(claimText) : [];

    if (rows.length !== 1) {
      return res.status(409).json({
        success: false,
        message:
          "Order 56 tidak ditemukan, bukan pending, atau sudah diproses. Tidak ada transaksi dikirim."
      });
    }

    const order = rows[0];

    if (
      order.sku !== "dana50" ||
      order.customer_no !== order.player_id
    ) {
      return res.status(409).json({
        success: false,
        message: "Data order tidak cocok. Perlu pemeriksaan manual."
      });
    }

    const result = await sendDigiflazz({
      order_id: ORDER_ID,
      sku: order.sku,
      customer_no: order.customer_no
    });

    const status = String(
      result?.data?.status || result?.status || ""
    ).toLowerCase();

    let topupStatus;

    if (status === "sukses") {
      topupStatus = "success";
    } else if (status === "gagal") {
      topupStatus = "failed";
    } else {
      return res.status(202).json({
        success: true,
        message:
          "Transaksi sudah dikirim, status belum final. Jangan kirim ulang.",
        order_id: ORDER_ID,
        digiflazz_status: status || "unknown",
        topup_status: "processing"
      });
    }

    const updateResponse = await fetch(
      `${base}/rest/v1/orders?order_id=eq.${encodeURIComponent(ORDER_ID)}&orders_id=eq.56&topup_status=eq.processing`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          topup_status: topupStatus
        })
      }
    );

    if (!updateResponse.ok) {
      throw new Error(
        "Transaksi dijawab Digiflazz, tetapi update status Supabase gagal."
      );
    }

    return res.status(200).json({
      success: true,
      order_id: ORDER_ID,
      digiflazz_status: status,
      topup_status: topupStatus
    });

  } catch (error) {
    console.error("ORDER_56_RECOVERY_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message:
        "Hasil belum dapat dipastikan. Jangan kirim ulang transaksi.",
      order_id: ORDER_ID
    });
  }
};
      
