
import crypto from "node:crypto";
import https from "node:https";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_PROD_KEY;
  const proxyUrl = process.env.DIGIFLAZZ_PROXY_URL;

  if (!username || !apiKey || !proxyUrl) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Digiflazz belum lengkap"
    });
  }

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error("URL proxy tidak valid");
    }

    const agent = new https.Agent({
      proxyEnv: {
        HTTPS_PROXY: proxyUrl
      }
    });

    try {
      const sign = crypto
        .createHash("md5")
        .update(username + apiKey + "depo")
        .digest("hex");

      const result = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          cmd: "deposit",
          username,
          sign
        });

        const request = https.request(
          "https://api.digiflazz.com/v1/cek-saldo",
          {
            method: "POST",
            agent,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body)
            }
          },
          (response) => {
            let data = "";

            response.setEncoding("utf8");

            response.on("data", chunk => {
              data += chunk;
            });

            response.on("end", () => {
              try {
                resolve({
                  statusCode: response.statusCode,
                  data: JSON.parse(data)
                });
              } catch {
                reject(new Error("Respons Digiflazz bukan JSON valid"));
              }
            });

            response.on("error", reject);
          }
        );

        request.setTimeout(30000, () => {
          request.destroy(new Error("Koneksi Digiflazz timeout"));
        });

        request.on("error", reject);
        request.write(body);
        request.end();
      });

      if (
        result.statusCode < 200 ||
        result.statusCode >= 300
      ) {
        throw new Error("Permintaan cek saldo Digiflazz gagal");
      }

      return res.status(200).json({
        success: true,
        data: result.data
      });

    } finally {
      agent.destroy();
    }

  } catch (error) {
    console.error("CEK_SALDO_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil saldo Digiflazz"
    });
  }
}
