
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_PROD_KEY;

  if (!username || !apiKey) {
    res.setHeader("Cache-Control", "no-store");
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

    const response = await fetch(
      "https://api.digiflazz.com/v1/price-list",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          cmd: "prepaid",
          username,
          sign
        })
      }
    );

    const data = await response.json();

    // Jangan simpan respons error atau RC 83
    if (!response.ok || !Array.isArray(data.data)) {
      res.setHeader("Cache-Control", "no-store");

      return res.status(response.ok ? 503 : 502).json(data);
    }

    // Cache daftar produk valid selama 5 menit
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );

    return res.status(200).json(data);

  } catch (error) {
    res.setHeader("Cache-Control", "no-store");

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar produk"
    });
  }
}
