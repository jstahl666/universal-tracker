// Universal Tracker — homeserver scraper service.
//
// Runs a persistent headless(ish) Chromium via Playwright and exposes a tiny
// HTTP API the tracker calls for marketplaces that block the Cloudflare Worker
// (datacenter IP + non-browser detection). Because this runs on the homeserver
// — a residential IP with a real browser engine — those sites treat it like a
// normal visitor.
//
//   GET /listings?source=craigslist&q=<query>&region=<sub>&min=<usd>&max=<usd>
//   -> { source, listings:[ {title,price,currency,url,image,condition,location} ] }
//   GET /health  -> { ok:true }
//
// Public exposure is via Cloudflare Tunnel (see README); the tracker's
// watchlist.json config.scraperProxy points at that hostname.

import http from "http";
import { chromium } from "playwright";
import { craigslist } from "./sources/craigslist.js";

const PORT = process.env.PORT || 8791;  // 8080 is taken by another homeserver service
// A shared browser context, reused across requests for speed. A realistic UA +
// viewport so the pages behave like a normal desktop Chrome.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

let browser = null, context = null;
async function getContext() {
  if (context) return context;
  browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  return context;
}

const SOURCES = { craigslist };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function send(res, status, obj) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, CORS));
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health") return send(res, 200, { ok: true });
  if (u.pathname !== "/listings") return send(res, 404, { error: "not found" });

  const source = (u.searchParams.get("source") || "").toLowerCase();
  const q = (u.searchParams.get("q") || "").trim();
  const region = u.searchParams.get("region") || "";
  const min = u.searchParams.get("min") || "";
  const max = u.searchParams.get("max") || "";
  if (!q) return send(res, 400, { error: "missing q" });
  const fn = SOURCES[source];
  if (!fn) return send(res, 400, { error: "unknown source: " + source });

  let page;
  try {
    const ctx = await getContext();
    page = await ctx.newPage();
    // Block heavy resources we don't need (fonts/media) to speed pages up;
    // keep images since we surface listing thumbnails.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    const listings = await fn(page, { q, region, min, max });
    // Relevance: these sites do loose keyword matching and return unrelated
    // items (even a Herman Miller *clock* for an "aeron" search). The model
    // name is the distinctive token and is almost always last, so require the
    // last meaningful query word (>= 3 chars) to appear in the title.
    const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter(Boolean);
    let model = "";
    for (let i = words.length - 1; i >= 0; i--) { if (words[i].length >= 3) { model = words[i]; break; } }
    const lo = min ? Number(min) : null, hi = max ? Number(max) : null;
    const filtered = listings.filter((l) => {
      if (model && !(l.title || "").toLowerCase().includes(model)) return false;
      // Apply the numeric range here too (some sites ignore the URL params).
      if (l.price == null) return true;
      if (lo != null && l.price < lo) return false;
      if (hi != null && l.price > hi) return false;
      return true;
    }).slice(0, 20);
    send(res, 200, { source, listings: filtered });
  } catch (e) {
    send(res, 502, { source, error: String((e && e.message) || e) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

server.listen(PORT, () => console.log("scraper listening on :" + PORT));

// Clean shutdown so the browser doesn't linger.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
}
