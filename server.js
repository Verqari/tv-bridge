console.log("DEPLOY VERSION: bitget-sign-fix-2025-12-22-C");

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ type: "*/*" }));

const PORT = process.env.PORT || 3000;

// ====== SET THESE IN RENDER → Environment ======
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_API_SECRET = process.env.BITGET_API_SECRET;
const BITGET_API_PASS = process.env.BITGET_API_PASS;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
// ==============================================

console.log("Bitget TradingView Bridge starting...");
console.log("PORT =", PORT);
console.log("ENV OK =", {
  BITGET_API_KEY: !!BITGET_API_KEY,
  BITGET_API_SECRET: !!BITGET_API_SECRET,
  BITGET_API_PASS: !!BITGET_API_PASS,
  BRIDGE_SECRET: !!BRIDGE_SECRET
});
console.log("BRIDGE_SECRET length:", (BRIDGE_SECRET || "").length);

if (typeof fetch !== "function") {
  throw new Error("Global fetch is not available. Set Render Node version to 18+.");
}

// ✅ Bitget v2 signature: base64(HMAC_SHA256(secret, prehash))
function signRequest(method, path, timestamp, body = "") {
  const prehash = `${timestamp}${method.toUpperCase()}${path}${body}`;
  return crypto
    .createHmac("sha256", BITGET_API_SECRET)
    .update(prehash)
    .digest("base64");
}

// Request logger
app.use((req, _res, next) => {
  console.log(`[IN] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/hook", async (req, res) => {
  try {
    const p = req.body ?? {};
    console.log("[HOOK BODY]", JSON.stringify(p));

    // Secret validation (trim to avoid whitespace paste issues)
    const expectedSecret = (BRIDGE_SECRET ?? "").trim();
    const incomingSecret = (p.secret ?? "").trim();

    if (!expectedSecret) {
      return res.status(500).json({ ok: false, error: "bridge_secret_not_set" });
    }
    if (!incomingSecret || incomingSecret !== expectedSecret) {
      return res.status(403).json({
        ok: false,
        error: "unauthorized",
        details: { expectedLen: expectedSecret.length, gotLen: incomingSecret.length }
      });
    }

    // Timestamp validation
    const nowSec = Math.floor(Date.now() / 1000);
    const maxLag = Math.max(0, Number(p.max_lag ?? 600) || 600);

    let tsNum = Number(p.timestamp);
    if (Number.isFinite(tsNum) && tsNum > 1e12) tsNum = Math.floor(tsNum / 1000);
    if (!Number.isFinite(tsNum) || tsNum <= 0) tsNum = nowSec;

    const lag = Math.abs(nowSec - tsNum);
    if (lag > maxLag) {
      return res.status(400).json({
        ok: false,
        error: "stale_or_future_signal",
        details: { nowSec, tsNum, maxLag, lag }
      });
    }

    // Validate action & amount
    const action = (p.action || "").toLowerCase();
    if (!["buy", "sell", "long", "short"].includes(action)) {
      return res.status(400).json({ ok: false, error: "invalid_action", got: action });
    }

    const amount = Number(p.order?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount", got: p.order?.amount });
    }

    // Map action
    const side = (action === "sell" || action === "short") ? "sell" : "buy";
    const tradeSide = "open";

    // Order payload (your working format)
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
