
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
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!username || !apiKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi API belum lengkap"
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const cacheKey = "digiflazz_prepaid";

  try {
    // AMBIL CACHE DARI SUPABASE
    const cacheResponse = await fetch(
      `${baseUrl}/rest/v1/product_cache?cache_key=eq.${cacheKey}&select=response,updated_at&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    let cachedProduct = null;
    let cacheTime = 0;

    if (cacheResponse.ok) {
      const cacheData = await cacheResponse.json();

      if (cacheData.length > 0) {
        cachedProduct = cacheData[0].response;
        cacheTime = new Date(cacheData[0].updated_at).getTime();
      }
    }

    // GUNAKAN CACHE JIKA BELUM LEBIH DARI 5 MENIT
    if (
      cachedProduct &&
      Array.isArray(cachedProduct.data) &&
      Date.now() - cacheTime < 5 * 60 * 1000
    ) {
      res.setHeader(
        "Cache-Control",
        "public, s-maxage=300, stale-while-revalidate=600"
      );

      return res.status(200).json(cachedProduct);
    }

    // AMBIL PRODUK TERBARU DARI DIGIFLAZZ
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

    // JIKA DIGIFLAZZ GAGAL, GUNAKAN CACHE LAMA
    if (!response.ok || !Array.isArray(data.data)) {
      if (cachedProduct && Array.isArray(cachedProduct.data)) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(cachedProduct);
      }

      res.setHeader("Cache-Control", "no-store");

      return res.status(503).json(data);
    }

    // SIMPAN PRODUK TERBARU KE SUPABASE
    await fetch(
      `${baseUrl}/rest/v1/product_cache?on_conflict=cache_key`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify({
          cache_key: cacheKey,
          response: data,
          updated_at: new Date().toISOString()
        })
      }
    );

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
