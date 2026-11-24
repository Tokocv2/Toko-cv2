
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
    typeof order.order_id !== "string" ||
    !order.order_id.trim() ||
    typeof order.sku !== "string" ||
    !order.sku.trim() ||
    typeof order.customer_no !== "string" ||
    !order.customer_no.trim()
  ) {
    throw new Error("Data pesanan Digiflazz tidak lengkap");
  }

  let parsedProxy;

  try {
    parsedProxy = new URL(proxyUrl);

    if (!["http:", "https:"].includes(parsedProxy.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error("Format URL proxy Digiflazz tidak valid");
  }

  const refId = order.order_id.trim();

  const sign = crypto
    .createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const payload = JSON.stringify({
    username,
    buyer_sku_code: order.sku.trim(),
    customer_no: order.customer_no.trim(),
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

          res.on("error", (error) => finish(error));
        }
      );

      timer = setTimeout(() => {
        request.destroy(
          new Error("Koneksi Digiflazz timeout 30 detik")
        );
      }, 30000);

      request.on("error", (error) => finish(error));

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

    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.status !== "string"
    ) {
      throw new Error(
        "Format respons transaksi Digiflazz tidak valid"
      );
    }

    if (
      result.ref_id &&
      String(result.ref_id) !== refId
    ) {
      throw new Error(
        "Referensi transaksi Digiflazz tidak cocok"
      );
    }

    const status = result.status.trim().toLowerCase();

    if (!["sukses", "gagal", "pending"].includes(status)) {
      throw new Error(
        "Status respons Digiflazz tidak dikenali"
      );
    }

    return result;

  } finally {
    agent.destroy();
  }
}

module.exports = sendDigiflazz;
