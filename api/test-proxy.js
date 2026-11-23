
const https = require("https");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false });
  }

  const proxyUrl = process.env.DIGIFLAZZ_PROXY_URL;

  if (!proxyUrl) {
    return res.status(500).json({
      success: false,
      message: "DIGIFLAZZ_PROXY_URL tidak ditemukan"
    });
  }

  const agent = new https.Agent({
    proxyEnv: { HTTPS_PROXY: proxyUrl }
  });

  try {
    const result = await new Promise((resolve, reject) => {
      https.get("https://api.ipify.org?format=json", { agent }, (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", chunk => data += chunk);
        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Respons IP tidak valid"));
          }
        });
        response.on("error", reject);
      }).on("error", reject);
    });

    return res.status(200).json({
      success: true,
      exit_ip: result.ip,
      expected_ip: "46.173.78.193",
      match: result.ip === "46.173.78.193"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  } finally {
    agent.destroy();
  }
};
