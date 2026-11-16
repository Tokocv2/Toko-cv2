export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_PROD_KEY;

  if (!username || !apiKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Digiflazz belum lengkap"
    });
  }

  try {
    const crypto = await import("node:crypto");
    const sign = crypto
      .createHash("md5")
      .update(username + apiKey + "pricelist")
      .digest("hex");

    const response = await fetch("https://api.digiflazz.com/v1/price-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "prepaid",
        username,
        sign
      })
    });

    const data = await response.json();
    return res.status(response.ok ? 200 : 502).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar produk"
    });
  }
}
