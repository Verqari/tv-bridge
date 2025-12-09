// server.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ⚠️ REPLACE THESE WITH YOUR REAL VALUES
const BITGET_API_KEY = process.env.BITGET_API_KEY || "bg_614d0aff7aed6eb327bd7256d34ba676";
const BITGET_API_SECRET = process.env.BITGET_API_SECRET || "14040178";
const BITGET_API_PASS = process.env.BITGET_API_PASS || "973114d0727fe00f0df88baae06c6a36d43cb3150d989114bc03782a840627fa";
const BRIDGE_SECRET = "14040178"; // same as in your TradingView webhook URL
// =====================================

// Bitget v2 signer: HMAC-SHA256, base64
function signRequest(method, path, timestamp, body = "") {
  const prehash = timestamp + method + path + "" + body;
  return crypto.createHmac("sha256", API_SECRET).update(prehash).digest("base64");
}

// Map TradingView instrument to Bitget symbol
function mapSymbol(tvInstr) {
  const s = String(tvInstr || "").toUpperCase();
  const base = s.includes(":") ? s.split(":").pop() : s;
  if (base.includes("BTC") && base.includes("USDT")) return "BTCUSDT";
  if (base.includes("ETH") && base.includes("USDT")) return "ETHUSDT";
  if (/^[A-Z]{3,5}USDT$/.test(base)) return base;
  return base;
}

// Health check
app.get("/health", (req, res) => {
  res.send("OK (render bridge up)");
});

// Webhook endpoint
app.post("/hook", async (req, res) => {
  try {
    const p = req.body || {};

    // 1) Simple secret check from JSON body
    if (!p.secret || p.secret !== BRIDGE_SECRET) {
      return res.status(403).json({ ok: false, error: "Unauthorized (secret)" });
    }

    // 2) Freshness check
    const nowSec = Math.floor(Date.now() / 1000);
    const tsRaw = (p.timestamp || "").toString().trim();
    const tsNum = tsRaw.length > 10 ? Math.floor(Number(tsRaw) / 1000) : Number(tsRaw);
    const maxLagSec = Number(p.max_lag || 600);
    if (!isFinite(tsNum) || Math.abs(nowSec - tsNum) > maxLagSec) {
      return res.status(400).json({
        ok: false,
        error: "stale_or_future_signal",
        details: { nowSec, tsNum, maxLagSec }
      });
    }

    // 3) Symbol and side
    const tvInstr = p.tv_instrument || p.symbol;
    const symbol = mapSymbol(tvInstr);

    const action = String(p.action || p.side || "").toLowerCase();
    let side;
    if (action === "buy" || action === "long") side = "open_long";
    else if (action === "sell" || action === "short") side = "open_short";
    else if (action === "close_long" || action === "close_short") side = action;
    else {
      return res.status(400).json({ ok: false, error: `invalid action '${action}'` });
    }

    // 4) Quantity
    const qtyRaw = Number((p.order && p.order.amount) || p.qty || 0);
    if (!isFinite(qtyRaw) || qtyRaw <= 0) {
      return res.status(400).json({ ok: false, error: "qty invalid" });
    }

    const order = {
      symbol,
      marginCoin: "USDT",
      side,
      orderType: "market",
      size: String(qtyRaw),
      reduceOnly: side.startsWith("close"),
      clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    };

    // 5) Bitget v2 endpoint
    const pathV2 = "/api/v2/mix/order/place-order";
    const bodyStr = JSON.stringify(order);
    const tsMs = Date.now().toString();
    const sig = signRequest("POST", pathV2, tsMs, bodyStr);

    const headers = {
      "ACCESS-KEY": API_KEY,
      "ACCESS-SIGN": sig,
      "ACCESS-PASSPHRASE": PASSPHRASE,
      "ACCESS-TIMESTAMP": tsMs,
      "Content-Type": "application/json"
    };

    // 6) Send to Bitget
    const resp = await axios.post("https://api.bitget.com" + pathV2, bodyStr, {
      headers
    });

    return res.json({ ok: true, sent: true, bitget: resp.data, order });
  } catch (err) {
    console.error("ERROR /hook:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ ok: false, error: err.message, bitget: err.response?.data || null });
  }
});

app.listen(PORT, () => {
  console.log(`tv-bitget bridge listening on port ${PORT}`);
});
