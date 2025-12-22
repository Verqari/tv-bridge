console.log("DEPLOY VERSION: tv-message-size-2025-12-22-D");

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

// New: default order size when TradingView doesn't provide one
const DEFAULT_SIZE = Number(process.env.DEFAULT_SIZE || "0.001");

// Optional: enable closing on exit alerts (off by default)
const CLOSE_ON_EXIT = String(process.env.CLOSE_ON_EXIT || "false").toLowerCase() === "true";

// Optional: default symbol if you don't want mapping yet
const DEFAULT_SYMBOL = process.env.DEFAULT_SYMBOL || "BTCUSDT";
const DEFAULT_PRODUCT_TYPE = process.env.DEFAULT_PRODUCT_TYPE || "USDT-FUTURES";
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
console.log("DEFAULT_SIZE =", DEFAULT_SIZE);
console.log("CLOSE_ON_EXIT =", CLOSE_ON_EXIT);
console.log("DEFAULT_SYMBOL =", DEFAULT_SYMBOL);

if (typeof fetch !== "function") {
  throw new Error("Global fetch is not available. Set Render Node version to 18+.");
}

// Bitget v2 signature: base64(HMAC_SHA256(secret, prehash))
function signRequest(method, path, timestamp, body = "") {
  const prehash = `${timestamp}${method.toUpperCase()}${path}${body}`;
  return crypto
    .createHmac("sha256", BITGET_API_SECRET)
    .update(prehash)
    .digest("base64");
}

app.use((req, _res, next) => {
  console.log(`[IN] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get("/", (_req, res) => res.status(200).send("OK"));

function normalizeSymbol(tvInstrument) {
  // You can expand mapping later. For now, keep it safe:
  // Examples: "BTCUSDT.P" -> "BTCUSDT", "BITGET:BTCUSDTPERP" -> "BTCUSDT"
  const s = String(tvInstrument || "").toUpperCase();

  if (!s) return DEFAULT_SYMBOL;

  // strip exchange prefix if present
  const noPrefix = s.includes(":") ? s.split(":").pop() : s;

  // common perp suffix styles
  let out = noPrefix.replace(".P", "");
  out = out.replace("PERP", "");
  out = out.replace("USDTP", "USDT"); // safety

  // final fallback
  return out || DEFAULT_SYMBOL;
}

app.post("/hook", async (req, res) => {
  try {
    const p = req.body ?? {};
    console.log("[HOOK BODY]", JSON.stringify(p));

    // ---- Secret validation (trim) ----
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

    // ---- Timestamp validation ----
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

    // ---- Derive action ----
    // Preferred: p.action (from order fills)
    // Fallback: p.tv_message (from alertcondition / {{message}})
    let action = (p.action || "").toLowerCase();

    if (!action) {
      const msg = String(p.tv_message || p.message || "").toLowerCase();
      if (msg === "start_long" || msg === "long_entry") action = "buy";
      else if (msg === "close_at_market" || msg === "exit_trade") action = "close";
    }

    if (!action) {
      return res.status(400).json({ ok: false, error: "missing_action", hint: "send action or tv_message={{message}}" });
    }

    // ---- Derive amount ----
    // If TradingView sent it, use it. Otherwise use DEFAULT_SIZE.
    let amount = Number(p.order?.amount ?? 0);

    // Some TV placeholders arrive as strings; try to parse cleanly
    if (!Number.isFinite(amount) || amount <= 0) {
      const rawAmt = p.order?.amount;
      const parsed = Number(String(rawAmt || "").trim());
      if (Number.isFinite(parsed) && parsed > 0) amount = parsed;
    }

    // Final fallback
    if (!Number.isFinite(amount) || amount <= 0) amount = DEFAULT_SIZE;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount", got: p.order?.amount, defaultSize: DEFAULT_SIZE });
    }

    // ---- Symbol ----
    const symbol = normalizeSymbol(p.tv_instrument || p.tv_symbol || "");
    const productType = DEFAULT_PRODUCT_TYPE;

    // ---- If close signal ----
    if (action === "close") {
      if (!CLOSE_ON_EXIT) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "close_signal_received_but_CLOSE_ON_EXIT_false",
          timing: { nowSec, tsNum, maxLag, lag }
        });
      }

      // Close (market) - reduce only style close for USDT futures (Bitget v2)
      // NOTE: Close semantics can differ by account position mode. This is a best-effort “close long” implementation.
      const closeOrder = {
        symbol,
        productType,
        marginMode: "crossed",
        marginCoin: "USDT",
        // For closing, size can be used as reduce size. If you want "close all", we can add a position query.
        size: amount.toString(),
        side: "sell",
        tradeSide: "close",
        orderType: "market",
        clientOid: `tv-close-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      };

      const urlPath = "/api/v2/mix/order/place-order";
      const body = JSON.stringify(closeOrder);
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
      console.log("[BITGET CLOSE STATUS]", response.status);
      console.log("[BITGET CLOSE BODY]", text);

      let bitget;
      try { bitget = JSON.parse(text); } catch { bitget = { raw: text }; }

      return res.status(response.status).json({
        ok: response.ok,
        bitget,
        closeOrder,
        timing: { nowSec, tsNum, maxLag, lag }
      });
    }

    // ---- Open long (buy) / open short (sell) ----
    // Your Pine strategy is long-only right now, but we support short signals too if you ever add them.
    const side = (action === "sell" || action === "short") ? "sell" : "buy";
    const tradeSide = "open";

    const orderSent = {
      symbol,
      productType,
      marginMode: "crossed",
      marginCoin: "USDT",
      size: amount.toString(),
      side,
      tradeSide,
      orderType: "market",
      clientOid: `tv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    };

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
