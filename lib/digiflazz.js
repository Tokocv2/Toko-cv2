
const crypto = require("node:crypto");
const https = require("node:https");

async function sendDigiflazz(order) {
  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_PROD_KEY;
  const proxyUrl = process.env.DIGIFLAZZ_PROXY_URL;

  if (!username || !apiKey || !proxyUrl) {
    throw new Error("Konfigurasi Digiflazz belum lengkap");
  }

  if (
    !order ||
    !order.order_id ||
    !order.sku ||
    !order.customer_no
  ) {
    throw new Error("Data pesanan Digiflazz tidak lengkap");
  }

  try {
    const parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error("Format URL proxy Digiflazz tidak valid");
  }

  const refId = String(order.order_id);

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

  try {
    const response = await new Promise((resolve, reject) => {
      let finished = false;
      let timer;

      const finish = (error, result) => {
        if (finished) return;

        finished = true;
        clearTimeout(timer);

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      const request = https.request(
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
          let tooLarge = false;

          res.setEncoding("utf8");

          res.on("data", (chunk) => {
            if (tooLarge) return;

            body += chunk;

            if (Buffer.byteLength(body) > 1024 * 1024) {
              tooLarge = true;
              res.destroy(
                new Error("Respons Digiflazz terlalu besar")
              );
            }
          });

          res.on("end", () => {
            if (tooLarge) return;

            let data;

            try {
              data = JSON.parse(body);
            } catch {
              return finish(
                new Error("Respons Digiflazz bukan JSON yang valid")
              );
            }

            finish(null, {
              statusCode: res.statusCode,
              data
            });
          });

          res.on("error", finish);
        }
      );

      timer = setTimeout(() => {
        request.destroy(
          new Error("Koneksi Digiflazz timeout 30 detik")
        );
      }, 30000);

      request.on("error", finish);
      request.write(payload);
      request.end();
    });

    if (
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      throw new Error(
        response.data?.data?.message ||
        response.data?.message ||
        "Gagal menghubungi Digiflazz"
      );
    }

    const result = response.data?.data;

    if (!result || typeof result !== "object") {
      throw new Error(
        "Format respons transaksi Digiflazz tidak valid"
      );
    }

    return result;

  } finally {
    agent.destroy();
  }
}

module.exports = sendDigiflazz;
