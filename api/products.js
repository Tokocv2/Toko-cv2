
import crypto from "node:crypto";
import https from "node:https";

async function sendDigiflazzRequest(proxyUrl, payload) {
  const agent = new https.Agent({
    proxyEnv: {
      HTTPS_PROXY: proxyUrl
    }
  });

  try {
    return await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);

      const request = https.request(
        "https://api.digiflazz.com/v1/price-list",
        {
          method: "POST",
          agent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          }
        },
        (response) => {
          let result = "";

          response.setEncoding("utf8");
          response.on("data", chunk => {
            result += chunk;
          });

          response.on("end", () => {
            try {
              resolve({
                statusCode: response.statusCode,
                data: JSON.parse(result)
              });
            } catch {
              reject(new Error("Respons Digiflazz bukan JSON yang valid"));
            }
          });

          response.on("error", reject);
        }
      );

      request.setTimeout(30000, () => {
        request.destroy(new Error("Koneksi proxy Digiflazz timeout"));
      });

      request.on("error", reject);
      request.write(body);
      request.end();
    });
  } finally {
    agent.destroy();
  }
}

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
  const proxyUrl = process.env.DIGIFLAZZ_PROXY_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!username || !apiKey || !proxyUrl || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi API belum lengkap"
    });
  }

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error();
    }
  } catch {
    return res.status(500).json({
      success: false,
      message: "Format URL proxy Digiflazz tidak valid"
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const cacheKey = "digiflazz_prepaid";

  let cachedProduct = null;

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

    // SIGNATURE DIGIFLAZZ PRODUCTION
    const sign = crypto
      .createHash("md5")
      .update(username + apiKey + "pricelist")
      .digest("hex");

    // AMBIL PRODUK MELALUI PROXY NODE4
    const response = await sendDigiflazzRequest(proxyUrl, {
      cmd: "prepaid",
      username,
      sign
    });

    const data = response.data;

    // JIKA DIGIFLAZZ GAGAL, GUNAKAN CACHE LAMA
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      !Array.isArray(data.data)
    ) {
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
    console.error("Digiflazz products error:", error);

    if (cachedProduct && Array.isArray(cachedProduct.data)) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(cachedProduct);
    }

    res.setHeader("Cache-Control", "no-store");

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar produk"
    });
  }
}
