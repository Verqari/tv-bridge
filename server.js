import crypto from "crypto";
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === IMPORTANT: EDIT THESE ===
const BITGET_API_KEY = env.BITGET_API_KEY || "bg_614d0aff7aed6eb327bd7256d34ba676";
const BITGET_API_SECRET = env.BITGET_API_SECRET || "14040178";
const BITGET_API_PASS = env.BITGET_API_PASS || "973114d0727fe00f0df88baae06c6a36d43cb3150d989114bc03782a840627fa";
const BRIDGE_SECRET = "14040178";        // TradingView secret
// ==============================


// Bitget signer
function signRequest(method, path, timestamp, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
}

// Webhook endpoint
app.post("/hook", async (req, res) => {
  try {
    const p = req.body;

    // Validate TradingView → Bridge secret
    if (!p || p.secret !== BRIDGE_SECRET)
      return res.status(403).json({ ok: false, error: "Unauthorized" });

    const action = p.action?.toLowerCase();
    const amount = Number(p.order?.amount || 0);

    if (!["buy", "sell", "long", "short"].includes(action))
      return res.status(400).json({ ok: false, error: "Invalid action" });

    const side =
      action === "buy" || action === "long" ? "open_long" : "open_short";

    const body = JSON.stringify({
      symbol: "BTCUSDT",
      marginCoin: "USDT",
      size: amount.toString(),
      side,
      orderType: "market",
      clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });

    const urlPath = "/api/mix/v1/order/placeOrder";
    const timestamp = Date.now().toString();
    const signature = signRequest("POST", urlPath, timestamp, body);

    const response = await fetch("https://api.bitget.com" + urlPath, {
      method: "POST",
      headers: {
        "ACCESS-KEY": API_KEY,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": PASSPHRASE,
        "Content-Type": "application/json"
      },
      body
    });

    const result = await response.json();
    return res.json({ ok: true, sent: result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log("Bridge online on port " + PORT));
