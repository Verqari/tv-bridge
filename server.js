
// server.js
const express = require("express");
const { BitgetApiClient } = require("bitget-api"); // official SDK

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==== EDIT THESE 4 ONLY ====================================
const API_KEY = "bg_6e19b0664e47d62f71d63fdb138a956f";
const API_SECRET = "83047d6f01051a2bed008765f0d8b682afd41e35abc3cfe67053de0c41e7a462";
const PASSPHRASE = "FredaTV123"; // the API passphrase from Bitget
const BRIDGE_SECRET = "eyJhbGciOiJIUzI1NiJ9.eyJzaWduYWxzX3NvdXJjZV9pZCI6MTU1Mjc1fQ.9Tph5w-fPgUVMS7hCPkqe5RBMsmBAUsTxC8BWTuTL9E"; // the 'secret' field from your TV JSON
// ===========================================================

// Init Bitget SDK client (Mix/Futures)
const client = new BitgetApiClient({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  passphrase: PASSPHRASE
});

// Map TradingView instrument (e.g. BITGET:BTCUSDTPERP) to Bitget symbol
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
  res.send("OK (render + Bitget SDK up)");
});

// Main webhook endpoint
app.post("/hook", async (req, res) => {
  try {
    const p = req.body || {};

    // 1) Secret check – must match TradingView JSON "secret"
    if (!p.secret || p.secret !== BRIDGE_SECRET) {
      return res.status(403).json({ ok: false, error: "Unauthorized (secret mismatch)" });
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

    // 3) Symbol & side
    const tvInstr = p.tv_instrument || p.symbol;
    const symbol = mapSymbol(tvInstr);

    const action = String(p.action || p.side || "").toLowerCase();

    // We'll support only entry actions here
    // TV: "buy"/"sell" from {{strategy.order.action}}
    let tradeSide;
    if (action === "buy" || action === "long" || action === "open_long") {
      tradeSide = "buy";
    } else if (action === "sell" || action === "short" || action === "open_short") {
      tradeSide = "sell";
    } else {
      return res
        .status(400)
        .json({ ok: false, error: `invalid or unsupported action '${action}'` });
    }

    // 4) Quantity
    const qtyRaw = Number((p.order && p.order.amount) || p.qty || 0);
    if (!isFinite(qtyRaw) || qtyRaw <= 0) {
      return res.status(400).json({ ok: false, error: "qty invalid" });
    }

    // === Use Bitget SDK to place USDT-M Perp Market Order ===
    // productType: "USDT-FUTURES" = USDT-M perpetual futures
    const orderReq = {
      symbol,                  // BTCUSDT / ETHUSDT
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      size: String(qtyRaw),    // contracts / base amount
      side: tradeSide,         // 'buy' or 'sell'
      orderType: "market",
      // force (timeInForce) defaults via SDK; GTC by default
      clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    };

    const sdkResp = await client.mix.placeOrder(orderReq);

    return res.json({ ok: true, sent: true, bitget: sdkResp, order: orderReq });
  } catch (err) {
    console.error("ERROR /hook:", err.response?.data || err.message || err);
    return res.status(500).json({
      ok: false,
      error: err.message || "unknown_error",
      bitget: err.response?.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`tv-bitget SDK bridge listening on port ${PORT}`);
});
