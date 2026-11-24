import crypto from "node:crypto";
import https from "node:https";

const MAX_RESPONSE_SIZE = 1024 * 1024;

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
  const adminSecret = process.env.CEK_SALDO_SECRET;

  if (!username || !apiKey || !proxyUrl || !adminSecret) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi server belum lengkap"
    });
  }

  // Autentikasi khusus pemilik toko
  const authHeader = req.headers.authorization || "";
  const suppliedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  const expected = Buffer.from(adminSecret);
  const supplied = Buffer.from(suppliedSecret);

  if (
    !suppliedSecret ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      success: false,
      message: "Akses ditolak"
    });
  }

  let agent;

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error("URL proxy tidak valid");
    }

    agent = new https.Agent({
      proxyEnv: {
        HTTPS_PROXY: proxyUrl
      }
    });

    const sign = crypto
      .createHash("md5")
      .update(username + apiKey + "depo")
      .digest("hex");

    const body = JSON.stringify({
      cmd: "deposit",
      username,
      sign
    });

    const result = await new Promise((resolve, reject) => {
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
          const chunks = [];
          let totalBytes = 0;
          let tooLarge = false;

          response.on("data", (chunk) => {
            if (tooLarge) return;

            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);

            totalBytes += buffer.byteLength;

            if (totalBytes > MAX_RESPONSE_SIZE) {
              tooLarge = true;
              chunks.length = 0;

              response.destroy(
                new Error("Respons Digiflazz terlalu besar")
              );

              return;
            }

            chunks.push(buffer);
          });

          response.on("end", () => {
            if (tooLarge) return;

            try {
              const responseText = Buffer
                .concat(chunks, totalBytes)
                .toString("utf8");

              resolve({
                statusCode: response.statusCode,
                data: JSON.parse(responseText)
              });
            } catch {
              reject(
                new Error("Respons Digiflazz bukan JSON valid")
              );
            }
          });

          response.on("error", reject);
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

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error("Permintaan cek saldo gagal");
    }

    return res.status(200).json({
      success: true,
      data: result.data
    });

  } catch (error) {
    console.error("CEK_SALDO_ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil saldo Digiflazz"
    });

  } finally {
    if (agent) agent.destroy();
  }
}

