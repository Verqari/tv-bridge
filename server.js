console.log("DEPLOY VERSION: esm-fix-2025-12-22");

// server.js
import express from "express";
import crypto from "crypto";

// If your Node runtime is <18, uncomment this line and use node-fetch:
// import fetch from "node-fetch";

const app = express();
app.use(express.json({ type: "*/*" }));

const PORT = process.env.PORT || 3000;

// =====================================================
// 🔴 RED: CHANGE THESE IN RENDER ENVIRONMENT (NOT HERE)
// In Render → your service → Environment, create these:
// BITGET_API_KEY      = <your Bitget API key>
// BITGET_API_SECRET   = <your Bitget API secret>
// BITGET_API_PASS     = <your Bitget API passphrase>
// BRIDGE_SECRET       = <the "secret" you put in TradingView alert JSON>
// =====================================================
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_API_SECRET = process.env.BITGET_API_SECRET;
const BITGET_API_PASS = process.env.BITGET_API_PASS;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

// Startup check (does NOT print secrets)
console.log("Bitget TradingView Bridge starting...");
console.log("PORT =", PORT);
console.log("ENV OK =", {
  BITGET_API_KEY: !!BITGET_API_KEY,
  BITGET_API_SECRET: !!BITGET_API_SECRET,
  BITGET_API_PASS: !!BITGET_API_PASS,
  BRIDGE_SECRET: !!BRIDGE_SECRET
});

// Bitget request signer (matches your working endpoint)
function signRequest(method, path, timestamp, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", BITGET_API_SECRET)
    .update(message)
    .digest("hex");
}

// Basic request logger (helpful on Render)
app.use((req, _res, next) => {
  console.log(`[IN] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Health check
app.get("/", (_req, res) => res.status(200).send("OK"));

// Webhook endpoint TradingView -> Bridge
app.post("/hook", async (req, res) => {
  try {
    const p = req.body ?? {};
    console.log("[HOOK BODY]", JSON.stringify(p));

    // 1) Secret validation
    if (!BRIDGE_SECRET) {
      return res.status(500).json({ ok: false, error: "bridge_secret_not_set" });
    }
    if (p.secret !== BRIDGE_SECRET) {
      return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    // 2) Timestamp validation (FIX: avoid stale_or_future_signal blocking)
    const nowSec = Math.floor(Date.now() / 1000);

    // TradingView may send as string; normalize
    const maxLag = Math.max(0, Number(p.max_lag ?? 600) || 600);

    let tsNum = Number(p.timestamp);

    // If timestamp is milliseconds, convert to seconds
    if (Number.isFinite(tsNum) && tsNum > 1e12) tsNum = Math.floor(tsNum / 1000);

    // If missing/invalid, fall back to server time (don’t block trades)
    if (!Number.isFinite(tsNum) || tsNum <= 0) tsNum = nowSec;

    const lag = Math.abs(nowSec - tsNum);
    if (lag > maxLag) {
      return res.status(400).json({
        ok: false,
        error: "stale_or_future_signal",
        details: { nowSec, tsNum, maxLag, lag }
      });
    }

    // 3) Validate action and amount
    const action = (p.action || "").toLowerCase();
    if (!["buy", "sell", "long", "short"].includes(action)) {
      return res.status(400).json({ ok: false, error: "invalid_action", got: action });
    }

    const amount = Number(p.order?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount", got: p.order?.amount });
    }

    // 4) Map action to Bitget side/tradeSide
    const side = (action === "sell" || action === "short") ? "sell" : "buy";
    const tradeSide = "open";

    // 5) Default instrument (you can later map p.tv_instrument dynamically)
    const orderSent = {
      symbol: "BTCUSDT",
      productType: "USDT-FUTURES",
      marginMode: "crossed",
      marginCoin: "USDT",
      size: amount.toString(),
      side,
      tradeSide,
      orderType: "market",
      clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    };

    // 6) Send to Bitget
    if (!BITGET_API_KEY || !BITGET_API_SECRET || !BITGET_API_PASS) {
      return res.status(500).json({ ok: false, error: "bitget_env_not_set" });
    }

    const urlPath = "/api/v2/mix/order/place-order";
    const body = JSON.stringify(orderSent);
    const timestamp = Date.now().toString();
    const signature = signRequest("POST", urlPath, timestamp, body);

    const response = await fetch("https://api.bitget.com" + urlPath, {
      method: "POST",
      headers: {
        "ACCESS-KEY": BITGET_API_KEY,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": BITGET_API_PASS,
        "Content-Type": "application/json"
      },
      body
    });

    const text = await response.text();
    console.log("[BITGET STATUS]", response.status);
    console.log("[BITGET BODY]", text);

    let bitget;
    try { bitget = JSON.parse(text); } catch { bitget = { raw: text }; }

    return res.status(response.status).json({
      ok: response.ok,
      bitget,
      orderSent,
      timing: { nowSec, tsNum, maxLag, lag }
    });

  } catch (err) {
    console.error("[ERROR]", err);
    return res.status(500).json({ ok: false, error: err?.message || "server_error" });
  }
});

app.listen(PORT, () => console.log("Bridge online on port " + PORT));
