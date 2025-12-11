
// server.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==== EDIT THESE 4 ONLY ====================================
const API_KEY = "bg_6e19b0664e47d62f71d63fdb138a956f";
const API_SECRET = "83047d6f01051a2bed008765f0d8b682afd41e35abc3cfe67053de0c41e7a462";
const PASSPHRASE = "FredaTV123"; // the API passphrase from Bitget
const BRIDGE_SECRET = "eyJhbGciOiJIUzI1NiJ9.eyJzaWduYWxzX3NvdXJjZV9pZCI6MTU1Mjc1fQ.9Tph5w-fPgUVMS7hCPkqe5RBMsmBAUsTxC8BWTuTL9E"; // the 'secret' field from your TV JSON
// ===========================================================

// Bitget v2 signature generator
// prehash = timestamp + method.toUpperCase() + path + (body || "")
function sign(method, path, ts, body = "") {
  const pre = ts + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", API_SECRET).update(pre).digest("base64");
}

function mapSymbol(tvInstr) {
  const s = String(tvInstr || "").toUpperCase();
  const base = s.includes(":") ? s.split(":").pop() : s;
  if (base.includes("BTC") && base.includes("USDT")) return "BTCUSDT";
  if (base.includes("ETH") && base.includes("USDT")) return "ETHUSDT";
  if (/^[A-Z0-9]{3,6}USDT$/.test(base)) return base;
  return base;
}

app.get("/health", (req, res) => {
  res.send("OK (Bitget v2 bridge running)");
});

app.post("/hook", async (req, res) => {
  try {
    const p = req.body || {};

    // --- Secret check ---
    if (!p.secret || p.secret !== BRIDGE_SECRET) {
      return res.status(403).json({ ok: false, error: "Secret mismatch" });
    }

    // --- Freshness check ---
    const nowSec = Math.floor(Date.now() / 1000);
    const tsRaw = (p.timestamp || "").toString().trim();
    const tsNum = tsRaw.length > 10 ? Math.floor(Number(tsRaw) / 1000) : Number(tsRaw);
    const maxLag = Number(p.max_lag || 600);

    if (!isFinite(tsNum) || Math.abs(nowSec - tsNum) > maxLag) {
      return res.status(400).json({
        ok: false,
        error: "stale_or_future_signal",
        details: { nowSec, tsNum, maxLag }
      });
    }

    // --- Map symbol ---
    const symbol = mapSymbol(p.tv_instrument || p.symbol);

    // --- Side mapping ---
   const action = String(p.action || "").toLowerCase();
    let side = null;

    if (action === "buy" || action === "long" || action === "open_long") {
      side = "buy";
    } else if (action === "sell" || action === "short" || action === "open_short") {
      side = "sell";
    } else {
      return res.status(400).json({ ok: false, error: `invalid action '${action}'` });
    }


    // --- Qty ---
    const qty = Number((p.order && p.order.amount) || p.qty || 0);
    if (!isFinite(qty) || qty <= 0) {
      return res.status(400).json({ ok: false, error: "invalid qty" });
    }

    // --- v2 Bitget Order ---
    const path = "/api/v2/mix/order/place-order";

const order = {
  symbol,                     // BTCUSDT
  productType: "USDT-FUTURES",// USDT-M futures (per docs)
  marginMode: "crossed",      // cross margin (exact spelling)
  marginCoin: "USDT",
  size: String(qty),
  side,                       // 'buy' or 'sell'
  orderType: "market",
  clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
};


    const body = JSON.stringify(order);
    const tsMs = Date.now().toString();
    const signature = sign("POST", path, tsMs, body);

    const headers = {
      "ACCESS-KEY": API_KEY,
      "ACCESS-SIGN": signature,
      "ACCESS-PASSPHRASE": PASSPHRASE,
      "ACCESS-TIMESTAMP": tsMs,
      "Content-Type": "application/json"
    };

    const result = await axios.post("https://api.bitget.com" + path, body, { headers });

    return res.json({
      ok: true,
      bitget: result.data,
      orderSent: order
    });

  } catch (err) {
    console.error("HOOK ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      bitget: err.response?.data || null
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log("Bitget v2 TradingView Bridge running on port", PORT);
});
