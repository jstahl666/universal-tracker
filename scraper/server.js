// Universal Tracker — homeserver scraper service.
//
// Runs a persistent headless Chromium via Playwright and exposes a tiny HTTP API
// the tracker calls for marketplaces that block the Cloudflare Worker (datacenter
// IP + non-browser detection). Because this runs on the homeserver — a
// residential IP with a real browser engine — those sites treat it like a normal
// visitor.
//
//   GET /listings?source=craigslist&q=<query>&region=<sub>&min=<usd>&max=<usd>
//   -> { source, listings:[ {title,price,currency,url,image,condition,location} ] }
//   GET /health  -> { ok:true, browser:<bool> }
//
// Public exposure is via Tailscale Funnel (see README); the tracker's
// watchlist.json config.scraperProxy points at that hostname. Because that
// endpoint is public + unauthenticated, this file caps concurrency, rate-limits
// per IP, and self-heals a crashed browser so it can't be trivially DoS'd or
// wedged.

import http from "http";
import { chromium } from "playwright";
import { craigslist } from "./sources/craigslist.js";

const PORT = process.env.PORT || 8791;  // 8080 is taken by another homeserver service
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MAX_CONCURRENCY = 3;      // simultaneous browser pages (DoS guard)
const MAX_QUEUE = 12;           // pending requests beyond that → 503
const SCRAPE_DEADLINE_MS = 35000;
const RL_WINDOW_MS = 60 * 1000, RL_CAP = 60; // global requests/minute (see note below)

// ---- self-healing browser -------------------------------------------------
// ctxPromise memoizes the in-flight launch so concurrent cold callers share ONE
// browser (no orphaned duplicates). On disconnect (crash/OOM) we null it so the
// next request relaunches instead of handing back a dead context forever.
let browser = null, ctxPromise = null;
function getContext() {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    const b = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
    b.on("disconnected", () => { if (browser === b) { browser = null; ctxPromise = null; } });
    try {
      const c = await b.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: "en-US" });
      browser = b;
      return c;
    } catch (e) {
      // launch() already spawned a Chromium process; if newContext() fails we'd
      // otherwise drop the only reference to it (browser is still null) → orphan.
      await b.close().catch(() => {});
      throw e;
    }
  })().catch((err) => { ctxPromise = null; throw err; });
  return ctxPromise;
}

// A wedged-but-still-connected browser (GC/swap stall short of an OOM kill) never
// emits 'disconnected', so the self-heal above never fires and every subsequent
// getContext() hands back the same dead context. Force a relaunch by dropping the
// reference and closing it in the background.
function healBrowser() {
  const b = browser;
  browser = null; ctxPromise = null;
  if (b) b.close().catch(() => {});
}
function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---- concurrency limiter --------------------------------------------------
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENCY) { active++; return Promise.resolve(true); }
  if (waiters.length >= MAX_QUEUE) return Promise.resolve(false); // saturated → caller 503s
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next(true); else active--;
}

// ---- global rate limit ----------------------------------------------------
// Behind Tailscale Funnel the true client IP isn't available (cf-connecting-ip
// is client-settable here and req.socket is the funnel/loopback address), so
// per-IP limiting is both spoofable and self-defeating. The concurrency cap is
// the real resource guard; this global bucket just sheds obvious floods cheaply
// (429) before they ever reach the browser.
const GRL = [];
function globallyRateLimited(now) {
  while (GRL.length && now - GRL[0] >= RL_WINDOW_MS) GRL.shift();
  if (GRL.length >= RL_CAP) return true;
  GRL.push(now);
  return false;
}

const SOURCES = { craigslist };

// ---- accessory/parts filter (same shape as the eBay Worker) ---------------
// Two tiers so a real product that merely mentions an accessory ("Leap with
// headrest") is kept, while accessory-led listings ("Headrest for Aeron") drop.
const PART_STRONG = [
  "replacement", "spare", "for\\s+parts", "torsion", "gas\\s?lift",
  "sector\\s?gear", "grommets?", "tilt\\s?(?:kit|cam|knob|engine|handle)",
  "instructions?", "owners?\\s?manual",
];
const PART_WEAK = [
  "ear\\s?pads?", "pads?", "cushions?", "covers?", "cables?", "cords?",
  "connectors?", "plugs?", "adapters?", "adaptors?", "headbands?", "foam",
  "decorative\\s?rings?", "rings?", "mounts?", "stands?", "hangers?", "hooks?",
  "holders?", "cases?", "pouch", "bags?", "skins?", "wraps?", "kits?",
  "transmitters?", "chargers?", "docks?", "receivers?", "casters?", "wheels?",
  "cylinders?", "pistons?", "glides?", "screws?", "bolts?", "washers?", "parts?",
  "springs?", "knobs?", "handles?", "manuals?", "frames?", "backrests?",
  "back\\s?rests?", "back\\s?frames?", "mechanisms?", "controls?", "pieces?",
  "panels?", "cubicles?", "headrests?", "seat\\s?pans?", "seat\\s?backs?",
  "seats?", "yokes?", "spacers?", "arm\\s?rests?", "armrests?", "arm\\s?pads?",
  "armpads?", "slip\\s?covers?", "slipcovers?", "stickers?", "decals?",
];
const STRONG_RX = new RegExp("\\b(?:" + PART_STRONG.join("|") + ")\\b", "i");
const WEAK_ANY_RX = new RegExp("\\b(?:" + PART_WEAK.join("|") + ")\\b", "i");
const WEAK_LEAD_RX = new RegExp(
  "^\\s*(?:\\(?\\d+\\)?\\s+)?(?:new|used|oem|genuine|original|premium|pair\\s+of|set\\s+of|lot\\s+of|pair|set|lot|for)?\\s*(?:" +
  PART_WEAK.join("|") + ")\\b", "i");
const WEAK_FOR_RX = new RegExp(
  "\\b(?:" + PART_WEAK.join("|") + ")\\b[\\s\\S]{0,20}\\bfor\\b(?!\\s+(?:sale|trade|parts|pickup|pick\\s?up|ship|shipping|delivery|local|details|free|cheap|repair|you|me)\\b)", "i");
const MODEL_NUM_RX = /\b(?:[a-z]+\d[a-z0-9]*|\d{3,})\b/i;
function isAccessory(title) {
  const t = title || "";
  if (STRONG_RX.test(t)) return true;
  if (WEAK_LEAD_RX.test(t)) return true;
  if (WEAK_FOR_RX.test(t)) return true;
  const m = t.match(MODEL_NUM_RX);
  if (m && m.index > 0 && WEAK_ANY_RX.test(t.slice(0, m.index))) return true;
  return false;
}

// Distinctive model token: prefer a digit-bearing token (model numbers), else
// the last meaningful word. Normalizing away spaces/hyphens lets "HE-400SE",
// "HE 400 SE" and "HE400SE" all match. Fixes generic 'pro' and formatting drops.
function modelToken(q) {
  // split on spaces AND hyphens so "ath-r70x" yields "r70x", not a fused
  // "athr70x" that wouldn't match an "R70x"-only title.
  const words = q.toLowerCase().split(/[\s-]+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  const digits = words.filter((w) => /\d/.test(w) && w.length >= 2);
  if (digits.length) return digits[digits.length - 1];
  for (let i = words.length - 1; i >= 0; i--) if (words[i].length >= 3) return words[i];
  return "";
}
function matchesModel(title, model) {
  if (!model) return true;
  const nt = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "6xx"-style placeholder is a wildcard: match the literal ("hd6xx") OR the
  // real numbered variants it stands in for ("hd650"/"hd600"/"hd660").
  const xx = model.match(/^(\d)xx$/);
  if (xx) return new RegExp(xx[1] + "(?:xx|\\d\\d)").test(nt);
  return nt.includes(model);
}

// ---- HTTP -----------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://jstahl666.github.io",
  "http://localhost:8781", "http://localhost:8779", "http://localhost:8080",
];
function corsFor(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function send(res, status, obj, cors) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, cors));
  res.end(JSON.stringify(obj));
}

// Every await here is time-bounded so the caller's concurrency slot (released in
// its finally, only AFTER scrape settles) can never leak. getContext()/newPage()
// and page.close() all send CDP commands that hang forever on a wedged browser;
// without caps a single stall would pin a slot permanently (3 stalls → all 503).
// Browser-level timeouts force a relaunch; a plain scrape-timeout is usually just
// a slow page, so it does NOT nuke a browser other requests may be sharing.
async function scrape(fn, params) {
  let page;
  try {
    const ctx = await withTimeout(getContext(), 15000, "context-timeout");
    page = await withTimeout(ctx.newPage(), 10000, "newpage-timeout");
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      // keep images (we extract thumbnail URLs from the DOM); drop the heavy rest
      if (t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    return await withTimeout(fn(page, params), SCRAPE_DEADLINE_MS, "scrape-timeout");
  } catch (e) {
    if (/context-timeout|newpage-timeout/.test(String(e && e.message))) healBrowser();
    throw e;
  } finally {
    if (page) {
      try { await withTimeout(page.close(), 5000, "close-timeout"); }
      catch (e2) { if (/close-timeout/.test(String(e2 && e2.message))) healBrowser(); }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const cors = corsFor(req.headers.origin || "");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health") return send(res, 200, { ok: true, browser: !!(browser && browser.isConnected()) }, cors);
  if (u.pathname !== "/listings") return send(res, 404, { error: "not found" }, cors);

  const now = Date.now();
  if (globallyRateLimited(now)) return send(res, 429, { error: "busy — try again shortly" }, cors);

  const source = (u.searchParams.get("source") || "").toLowerCase();
  const q = (u.searchParams.get("q") || "").trim();
  const region = u.searchParams.get("region") || "";
  const min = u.searchParams.get("min") || "";
  const max = u.searchParams.get("max") || "";
  if (!q) return send(res, 400, { error: "missing q" }, cors);
  // own-property check so prototype members ("constructor" etc.) can't slip past
  if (!Object.prototype.hasOwnProperty.call(SOURCES, source)) return send(res, 400, { error: "unknown source" }, cors);

  const got = await acquire();
  if (!got) return send(res, 503, { error: "busy — try again shortly" }, cors);
  try {
    const listings = await scrape(SOURCES[source], { q, region, min, max });
    const model = modelToken(q);
    const lo = min ? Number(min) : null, hi = max ? Number(max) : null;
    const filtered = listings.filter((l) => {
      if (!matchesModel(l.title, model)) return false;
      if (isAccessory(l.title)) return false;
      if (l.price == null) return true;
      if (lo != null && l.price < lo) return false;
      if (hi != null && l.price > hi) return false;
      return true;
    }).slice(0, 20);
    send(res, 200, { source, listings: filtered }, cors);
  } catch (e) {
    // Log full error server-side; return a generic message to the client. A dead
    // browser is healed by the 'disconnected' handler (which nulls browser +
    // ctxPromise), so we deliberately do NOT close/reset here — doing so could
    // tear down a browser a concurrent request just relaunched.
    console.error("scrape error [" + source + "]:", (e && e.stack) || e);
    send(res, 502, { source, error: "scrape failed" }, cors);
  } finally {
    release();
  }
});

// Node's default socket timeouts still hold a hung handler's connection open; a
// request deadline bounds how long any one response can take.
server.requestTimeout = 45000;
server.headersTimeout = 20000;
server.listen(PORT, () => console.log("scraper listening on :" + PORT));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
}
