
const crypto = require("crypto");

async function sendDigiflazz(order) {
  const username = process.env.DIGIFLAZZ_USERNAME;
  const apiKey = process.env.DIGIFLAZZ_DEV_KEY;

  if (!username || !apiKey) {
    throw new Error("Konfigurasi Digiflazz Development belum lengkap");
  }

  const refId = order.order_id;

  const sign = crypto
    .createHash("md5")
    .update(username + apiKey + refId)
    .digest("hex");

  const response = await fetch(
    "https://api.digiflazz.com/v1/transaction",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        buyer_sku_code: order.sku,
        customer_no: order.customer_no,
        ref_id: refId,
        sign,
        testing: true
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.data?.message || "Gagal menghubungi Digiflazz"
    );
  }

  return result.data;
}

module.exports = sendDigiflazz;
