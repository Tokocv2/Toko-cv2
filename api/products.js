
import crypto from "node:crypto";
import https from "node:https";

let refreshPromise = null;

// Cache segar selama 30 menit
const CACHE_DURATION = 30 * 60 * 1000;

// Cache lama boleh digunakan maksimal 24 jam sejak berhasil diperbarui
const MAX_STALE_CACHE_AGE = 24 * 60 * 60 * 1000;

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

function getDigiflazzError(data, statusCode) {
  const message =
    data?.message ||
    data?.msg ||
    data?.error ||
    data?.data?.message ||
    data?.data?.msg;

  if (message) {
    return `Digiflazz: ${String(message).slice(0, 300)}`;
  }

  const keys =
    data && typeof data === "object"
      ? Object.keys(data).join(",")
      : typeof data;

  return `Respons Digiflazz tidak valid. HTTP ${statusCode}. Field: ${keys}`;
}

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
          const chunks = [];
          let totalBytes = 0;
          let settled = false;

          response.on("data", (chunk) => {
            if (settled) return;

            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);

            totalBytes += buffer.byteLength;

            if (totalBytes > MAX_RESPONSE_SIZE) {
              settled = true;

              reject(
                new Error(
                  "Respons Digiflazz melebihi batas 5 MB"
                )
              );

              response.destroy();
              return;
            }

            chunks.push(buffer);
          });

          response.on("end", () => {
            if (settled) return;
            settled = true;

            const result = Buffer.concat(
              chunks,
              totalBytes
            ).toString("utf8");

            try {
              resolve({
                statusCode: response.statusCode || 0,
                data: JSON.parse(result)
              });
            } catch {
              reject(
                new Error(
                  `Respons Digiflazz bukan JSON valid. HTTP ${response.statusCode}`
                )
              );
            }
          });

          response.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });

          response.on("aborted", () => {
            if (settled) return;
            settled = true;
            reject(new Error("Respons Digiflazz terputus"));
          });
        }
      );

      request.setTimeout(30000, () => {
        request.destroy(
          new Error("Koneksi Digiflazz timeout")
        );
      });

      request.on("error", reject);
      request.write(body);
      request.end();
    });
  } finally {
    agent.destroy();
  }
}

async function fetchFreshProducts({
  username,
  apiKey,
  proxyUrl,
  baseUrl,
  supabaseKey,
  cacheKey
}) {
  const sign = crypto
    .createHash("md5")
    .update(username + apiKey + "pricelist")
    .digest("hex");

  const response = await sendDigiflazzRequest(proxyUrl, {
    cmd: "prepaid",
    username,
    sign
  });

  const data = response.data;

  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !data ||
    !Array.isArray(data.data)
  ) {
    throw new Error(
      getDigiflazzError(data, response.statusCode)
    );
  }

  const saveResponse = await fetch(
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

  if (!saveResponse.ok) {
    console.error(
      "PRODUCT_CACHE_SAVE_ERROR:",
      await saveResponse.text()
    );
  }

  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
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

  if (
    !username ||
    !apiKey ||
    !proxyUrl ||
    !supabaseUrl ||
    !supabaseKey
  ) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi API belum lengkap"
    });
  }

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error("URL proxy tidak valid");
    }

    const baseUrl = supabaseUrl.replace(/\/+$/, "");
    const cacheKey = "digiflazz_prepaid";

    let cachedProduct = null;
    let cacheTime = 0;

    // BACA CACHE SUPABASE
    try {
      const cacheResponse = await fetch(
        `${baseUrl}/rest/v1/product_cache?cache_key=eq.${cacheKey}&select=response,updated_at&limit=1`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
          }
        }
      );

      if (cacheResponse.ok) {
        const cacheData = await cacheResponse.json();

        if (
          Array.isArray(cacheData) &&
          cacheData.length > 0 &&
          Array.isArray(cacheData[0].response?.data)
        ) {
          cachedProduct = cacheData[0].response;
          cacheTime = new Date(
            cacheData[0].updated_at
          ).getTime();
        }
      } else {
        console.error(
          "PRODUCT_CACHE_READ_ERROR:",
          await cacheResponse.text()
        );
      }
    } catch (error) {
      console.error(
        "PRODUCT_CACHE_READ_ERROR:",
        error.message
      );
    }

    // HITUNG USIA CACHE
    const cacheAge = Date.now() - cacheTime;

    const validCacheTime =
      Number.isFinite(cacheTime) &&
      cacheTime > 0 &&
      cacheAge >= 0;

    const cacheIsFresh =
      cachedProduct &&
      validCacheTime &&
      cacheAge < CACHE_DURATION;

    const cacheIsUsableAsFallback =
      cachedProduct &&
      validCacheTime &&
      cacheAge <= MAX_STALE_CACHE_AGE;

    // GUNAKAN CACHE SEGAR SELAMA 30 MENIT
    if (cacheIsFresh) {
      return res.status(200).json(cachedProduct);
    }

    // REFRESH PRODUK DARI DIGIFLAZZ
    try {
      if (!refreshPromise) {
        refreshPromise = fetchFreshProducts({
          username,
          apiKey,
          proxyUrl,
          baseUrl,
          supabaseKey,
          cacheKey
        }).finally(() => {
          refreshPromise = null;
        });
      }

      const freshProducts = await refreshPromise;

      return res.status(200).json(freshProducts);
    } catch (error) {
      console.error(
        "DIGIFLAZZ_PRODUCTS_ERROR:",
        error.message
      );

      // JIKA DIGIFLAZZ GAGAL, GUNAKAN CACHE LAMA
      // SELAMA USIANYA BELUM MELEWATI 24 JAM.
      // CACHE LAMA TIDAK DIHAPUS KARENA KEGAGALAN INI.
      if (
        cacheIsUsableAsFallback &&
        Array.isArray(cachedProduct.data)
      ) {
        console.warn(
          "PRODUCTS_CACHE_FALLBACK: Menggunakan cache lama yang masih dalam batas usia 24 jam"
        );

        return res.status(200).json(cachedProduct);
      }

      console.error(
        "PRODUCTS_CACHE_REJECTED: Cache sudah melewati batas usia 24 jam atau waktu cache tidak valid"
      );

      return res.status(503).json({
        success: false,
        message:
          "Daftar produk sementara tidak tersedia. Silakan coba lagi."
      });
    }
  } catch (error) {
    console.error(
      "PRODUCTS_API_ERROR:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server"
    });
  }
}
