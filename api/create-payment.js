
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi Midtrans belum lengkap"
    });
  }

  const { order_id, sku, customer_no } = req.body || {};

  const validCustomerNo =
    typeof customer_no === "string" &&
    /^(?:[0-9]{5,30})(?:\|[0-9]{1,20})?$/.test(customer_no);

  if (
    typeof sku !== "string" ||
    typeof order_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(sku) ||
    !/^TCV2-[0-9a-f-]{36}$/i.test(order_id) ||
    !validCustomerNo
  ) {
    return res.status(400).json({
      success: false,
      message: "Data pesanan tidak valid"
    });
  }

  try {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_PROD_KEY;

    if (!username || !apiKey) {
      return res.status(500).json({
        success: false,
        message: "Konfigurasi Digiflazz belum lengkap"
      });
    }

    const sign = crypto
      .createHash("md5")
      .update(username + apiKey + "pricelist")
      .digest("hex");

    const priceResponse = await fetch(
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

    const priceData = await priceResponse.json();

    if (
      !priceResponse.ok ||
      !Array.isArray(priceData.data)
    ) {
      return res.status(503).json({
        success: false,
        message: "Harga produk belum dapat diverifikasi"
      });
    }

    const product = priceData.data.find(item =>
      item.buyer_sku_code === sku &&
      item.buyer_product_status === true &&
      item.seller_product_status === true
    );

    if (
      !product ||
      !Number.isFinite(Number(product.price))
    ) {
      return res.status(400).json({
        success: false,
        message: "Produk tidak tersedia"
      });
    }

    const modal = Number(product.price);

    // MARKUP HARGA JUAL 13%
    const hargaJual = Math.round(modal * 1.13);

    const auth = Buffer
      .from(serverKey + ":")
      .toString("base64");

    const midtransResponse = await fetch(
      "https://api.midtrans.com/v2/charge",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": "Basic " + auth
        },
        body: JSON.stringify({
          payment_type: "qris",
          transaction_details: {
            order_id: order_id,
            gross_amount: hargaJual
          },
          item_details: [{
            id: sku,
            price: hargaJual,
            quantity: 1,
            name: String(
              product.product_name || sku
            ).slice(0, 50)
          }],
          custom_field1: customer_no
        })
      }
    );

    const payment = await midtransResponse.json();

    if (!midtransResponse.ok) {
      return res.status(502).json({
        success: false,
        message: "Gagal membuat tagihan Midtrans",
        detail:
          payment.message ||
          payment.status_message ||
          undefined
      });
    }

    return res.status(200).json({
      success: true,
      order_id: order_id,
      amount: hargaJual,
      payment: payment
    });

  } catch (error) {
    console.error("Create payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat pembayaran"
    });
  }
}
