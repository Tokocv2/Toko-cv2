
const crypto = require("crypto");
const https = require("https");

async function sendDigiflazz(order) {
  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_PROD_KEY;
  const proxyUrl = process.env.DIGIFLAZZ_PROXY_URL;

  if (!username || !apiKey) {
    throw new Error("Konfigurasi Digiflazz Production belum lengkap");
  }

  if (!proxyUrl) {
    throw new Error("Konfigurasi proxy Digiflazz belum lengkap");
  }

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error("Format URL proxy Digiflazz tidak valid");
  }

  const refId = order.order_id;

  const sign = crypto
    .createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const payload = JSON.stringify({
    username,
    buyer_sku_code: order.sku,
    customer_no: order.customer_no,
    ref_id: refId,
    sign,
    testing: false
  });

  const agent = new https.Agent({
    proxyEnv: {
      HTTPS_PROXY: proxyUrl
    }
  });

  let response;

  try {
    response = await new Promise((resolve, reject) => {
      const req = https.request(
        "https://api.digiflazz.com/v1/transaction",
        {
          method: "POST",
          agent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        },
        (res) => {
          let body = "";

          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });

          res.on("end", () => {
            try {
              resolve({
                statusCode: res.statusCode,
                data: JSON.parse(body)
              });
            } catch {
              reject(new Error("Respons Digiflazz bukan JSON yang valid"));
            }
          });

          res.on("error", reject);
        }
      );

      req.setTimeout(30000, () => {
        req.destroy(new Error("Koneksi proxy Digiflazz timeout"));
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  } finally {
    agent.destroy();
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      response.data?.data?.message || "Gagal menghubungi Digiflazz"
    );
  }

  return response.data.data;
}

module.exports = sendDigiflazz;
