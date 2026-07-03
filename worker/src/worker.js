// Universal Tracker — listings proxy (Cloudflare Worker)
//
// The dashboard is a static page, so its JavaScript can't fetch marketplace
// listings directly (CORS + auth + bot-blocking). This Worker runs server-side
// and returns clean normalized JSON the page can render as cards.
//
// Sources:
//   ebay    — eBay Browse API (needs credentials; app-only OAuth)
//   reddit  — Reddit search RSS feed (no auth); needs &sub=<subreddit>
//   (Craigslist/OfferUp/etc. are handled by the separate homeserver scraper.)
//
// Endpoint:  GET /?source=<src>&q=<query>&min=<usd>&max=<usd>[&sub=][&cat=]
// Response:  { source, listings:[ {title,price,currency,url,image,condition,location} ] }
//            or { source, error }
//
// Secrets (set with `wrangler secret put ...`) — eBay only:
//   EBAY_CLIENT_ID      — eBay App ID  (Client ID, Production keyset)
//   EBAY_CLIENT_SECRET  — eBay Cert ID (Client Secret, Production keyset)

// CORS is locked to the site origin so other websites can't drive-by the
// endpoint from visitors' browsers. (Doesn't stop server-side/curl callers —
// the Cache API + per-IP rate limit below bound that.)
const ALLOWED_ORIGINS = [
  "https://jstahl666.github.io",
  "http://localhost:8781", "http://localhost:8779", "http://localhost:8080",
];
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---- eBay OAuth app token (client-credentials) ----------------------------
// Cached in-isolate until it nears expiry. tokenPromise coalesces concurrent
// cold callers onto ONE token fetch (avoids a thundering herd of OAuth calls).
let tokenCache = { token: null, exp: 0 };
let tokenPromise = null;

async function ebayToken(env, now) {
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;
  if (tokenPromise) return tokenPromise;
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("eBay credentials not set (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)");
  }
  tokenPromise = (async () => {
    const basic = btoa(env.EBAY_CLIENT_ID + ":" + env.EBAY_CLIENT_SECRET);
    const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    });
    if (!r.ok) throw new Error("eBay token HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    const j = await r.json();
    tokenCache = { token: j.access_token, exp: now + (j.expires_in - 60) * 1000 };
    return tokenCache.token;
  })().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

function priceFilter(min, max) {
  min = (min || "").trim();
  max = (max || "").trim();
  if (min && max) return "price:[" + min + ".." + max + "]";
  if (max) return "price:[.." + max + "]";
  if (min) return "price:[" + min + "..]";
  return "";
}

// ---- accessory / parts filter (shared shape with the scraper) -------------
// Almost every part word (pads, case, headrest, casters…) ALSO appears in real
// full-product listings ("HD600 with new pads", "Leap with headrest"), so a
// blanket "contains the word" drop nukes real inventory. Two tiers instead:
//   STRONG  — words that essentially never appear on a whole product → drop anywhere
//   WEAK    — ambiguous nouns → drop only when the title is accessory-LED
//             (starts with the word) or uses an "<word> … for" construction.
const PART_STRONG = [
  "replacement", "spare", "for\\s+parts", "torsion", "gas\\s?lift",
  "sector\\s?gear", "grommets?", "tilt\\s?(?:kit|cam|knob|engine|handle)",
  "instructions?", "owners?\\s?manual", // docs, never a whole product
  // repair KIT/LINE/CABLE/PART = a part; a bare "repair"/"repairs" is NOT (it
  // appears on whole products, e.g. "No Repairs Needed") so don't drop on it.
  "repair\\s?(?:kits?|lines?|cables?|cords?|parts?)",
];
const PART_WEAK = [
  "ear\\s?pads?", "pads?", "cushions?", "covers?", "cables?", "cords?",
  "connectors?", "plugs?", "adapters?", "adaptors?", "headbands?", "foam",
  "decorative\\s?rings?", "rings?", "mounts?", "stands?", "hangers?", "hooks?",
  "holders?", "cases?", "pouch", "bags?", "skins?", "wraps?", "kits?",
  "transmitters?", "chargers?", "docks?", "receivers?", "casters?", "wheels?",
  "cylinders?", "pistons?", "glides?", "screws?", "bolts?", "washers?", "parts?",
  "springs?", "knobs?", "handles?", "manuals?", "frames?",
  "backrests?", "back\\s?rests?", "back\\s?frames?", "mechanisms?", "controls?",
  "pieces?", "panels?", "cubicles?", "headrests?", "seat\\s?pans?",
  "seat\\s?backs?", "seats?", "yokes?", "spacers?", "arm\\s?rests?", "armrests?",
  "arm\\s?pads?", "armpads?", "slip\\s?covers?", "slipcovers?", "stickers?", "decals?",
];
const STRONG_RX = new RegExp("\\b(?:" + PART_STRONG.join("|") + ")\\b", "i");
const WEAK_ANY_RX = new RegExp("\\b(?:" + PART_WEAK.join("|") + ")\\b", "i");
// accessory-led: optional count/qualifier, then a weak word near the start
const WEAK_LEAD_RX = new RegExp(
  "^\\s*(?:\\(?\\d+\\)?\\s+)?(?:new|used|oem|genuine|original|premium|pair\\s+of|set\\s+of|lot\\s+of|pair|set|lot|for)?\\s*(?:" +
  PART_WEAK.join("|") + ")\\b", "i");
// "<weak word> … for <brand/model>" — e.g. "Ear Pads for Sennheiser". The
// negative lookahead avoids false positives where "for" introduces a use-case or
// sale phrase on a WHOLE product ("HD650 with case for travel", "chair for sale"),
// not an accessory FOR something. Only accessory-led matches survive (see the
// position guard in isAccessory: this must fire BEFORE the first model token).
const WEAK_FOR_RX = new RegExp(
  "\\b(?:" + PART_WEAK.join("|") + ")\\b[\\s\\S]{0,20}\\bfor\\b(?!\\s+(?:" +
  "sale|trade|parts|pickup|pick\\s?up|ship|shipping|delivery|local|details|free|cheap|repair|you|me|" +
  "travel|gaming|home|office|work|desk|gym|studio|mixing|monitoring|recording|dj|kids?|adults?|" +
  "men|women|tall|short|comfort|use|everyday|daily|running|sports?|protection|storage|gifts?|the|my|your" +
  ")\\b)", "i");
// first MODEL token — 3+ digits (650, 1990) or a letter+digit blend (HD650,
// K712, V2). Excludes bare spec numbers like the "8" in "8 Core … Cable".
const MODEL_NUM_RX = /\b(?:[a-z]+\d[a-z0-9]*|\d{3,})\b/i;

// A title is an accessory when the accessory noun leads the product name rather
// than trailing it. Products read "<Brand> <Model> … <accessory>"; accessories
// read "<accessory> … for <Brand> <Model>" or "<accessory> - <Brand> <Model>".
function isAccessory(title) {
  const t = title || "";
  if (STRONG_RX.test(t)) return true;
  if (WEAK_LEAD_RX.test(t)) return true;
  const m = t.match(MODEL_NUM_RX);
  const modelIdx = m ? m.index : Infinity;
  // weak accessory word appearing BEFORE the first model-number token → led by
  // the accessory (e.g. "Custom Headphone Cable - AKG K712"). A weak word AFTER
  // the model is just a whole product mentioning an accessory ("HD650 w/ case").
  if (m && m.index > 0 && WEAK_ANY_RX.test(t.slice(0, m.index))) return true;
  // "<weak> … for <brand>" counts as an accessory when it LEADS the model —
  // otherwise "HD 650 … case for travel" (product) would be wrongly dropped. The
  // "for <use-case>" negative lookahead already spares real products; the position
  // guard additionally protects a trailing accessory on a product ("… casters for
  // carpet"). modelIdx===0 (title STARTS with the model, e.g. "HE400SE Cable for
  // Hifiman") makes the guard vacuous, so treat a match there as accessory too.
  const fm = WEAK_FOR_RX.exec(t);
  if (fm && (fm.index < modelIdx || modelIdx === 0)) return true;
  return false;
}

// ---- model-relevance gate (identical to the scraper) ----------------------
// Accessories with NO model number that don't lead with the accessory word slip
// past isAccessory (e.g. "NewFantasia … Balanced Headphone Cable" for a HiFiMan
// query). A relevance gate — does the title actually name the queried model? —
// drops off-topic parts that the category filter cross-lists in.
const GENERIC_WORDS = new Set([
  "office", "chair", "chairs", "desk", "desks", "seat", "seating", "stool",
  "headphone", "headphones", "earphone", "earphones", "headset", "monitor",
  "monitors", "speaker", "speakers", "ergonomic", "mesh", "task", "gaming",
  "wireless", "used", "new", "the", "pair", "set",
]);
function modelToken(q) {
  const words = (q || "").toLowerCase().split(/[\s-]+/).map(function (w) { return w.replace(/[^a-z0-9]/g, ""); }).filter(Boolean);
  const digits = words.filter(function (w) { return /\d/.test(w) && w.length >= 2; });
  if (digits.length) return digits[digits.length - 1];
  for (let i = words.length - 1; i >= 0; i--)
    if (words[i].length >= 3 && !GENERIC_WORDS.has(words[i])) return words[i];
  return "";
}
function matchesModel(title, model) {
  if (!model) return true;
  const nt = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const xx = model.match(/^(\d)xx$/);
  if (xx) return new RegExp(xx[1] + "(?:xx|\\d\\d)").test(nt);
  return nt.includes(model);
}

async function ebaySearch(env, q, min, max, now, cat) {
  const token = await ebayToken(env, now);
  const filters = ["priceCurrency:USD"];
  // Small ABSOLUTE floor (not a % of max): drop trivially-cheap parts without
  // amputating the legitimate low price band for expensive items.
  const FLOOR = 15;
  const maxN = Number((max || "").trim());
  let effMin = (min || "").trim();
  if (!effMin && maxN > FLOOR) effMin = String(FLOOR);
  const pf = priceFilter(effMin, max);
  if (pf) filters.push(pf);
  // Restrict to a leaf category (e.g. Headphones) so accessories/parts that
  // live in OTHER categories drop out. ACCESSORY filter catches cross-listed ones.
  cat = (cat || "").trim().replace(/[^0-9]/g, "");
  // Best Match (default relevance) — NOT sort=price. Price-ascending buries real
  // products under the cheapest accessories so the post-filter pool was starved.
  // Fetch a wide pool, drop accessories, keep 12. The frontend sorts by price.
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + "?q=" + encodeURIComponent(q)
    + "&limit=50"
    + (cat ? "&category_ids=" + cat : "")
    + "&filter=" + encodeURIComponent(filters.join(","));
  const r = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!r.ok) throw new Error("eBay search HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  const model = modelToken(q);
  return (j.itemSummaries || []).filter(function (it) {
    const title = it.title || "";
    return matchesModel(title, model) && !isAccessory(title);
  }).slice(0, 12).map(function (it) {
    const img = (it.image && it.image.imageUrl) ||
      (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) || "";
    return {
      title: it.title || "",
      price: it.price ? Number(it.price.value) : null,
      currency: (it.price && it.price.currency) || "USD",
      url: it.itemWebUrl || "",
      image: img,
      condition: it.condition || "",
      location: (it.itemLocation && (it.itemLocation.city || it.itemLocation.stateOrProvince || it.itemLocation.country)) || "",
    };
  });
}

// ---- shared XML/price helpers ---------------------------------------------
function textOf(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").trim();
}
function parsePrice(s) {
  const m = (s || "").match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
// ---- Reddit (search RSS/Atom feed — no auth) ------------------------------
function attrOf(block, tag, attr) {
  const m = block.match(new RegExp("<" + tag + "\\b[^>]*\\b" + attr + '="([^"]*)"', "i"));
  return m ? m[1] : "";
}
async function redditSearch(sub, q, min, max) {
  sub = (sub || "").trim().replace(/[^a-z0-9_]/gi, "");
  if (!sub) throw new Error("reddit: missing sub");
  const url = "https://www.reddit.com/r/" + sub + "/search.rss?restrict_sr=1&sort=new&limit=25&q=" + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UniversalTracker/1.0; +listings preview)",
      "Accept": "application/atom+xml, application/xml, text/xml",
    },
  });
  if (r.status === 429) throw new Error("Reddit rate-limited (429) — try again shortly");
  if (!r.ok) throw new Error("Reddit HTTP " + r.status);
  const xml = await r.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  const lo = min ? Number(min) : null, hi = max ? Number(max) : null;
  const model = modelToken(q);
  return entries.map(function (block) {
    const title = textOf(block, "title");
    let link = attrOf(block, "link", "href");
    if (!link) link = textOf(block, "link");
    return {
      title: title,
      price: parsePrice(title),
      currency: "USD",
      url: link,
      image: "",
      condition: "",
      location: "",
    };
  }).filter(function (l) {
    if (!l.title) return false;
    if (!matchesModel(l.title, model)) return false; // drop off-topic posts/parts
    if (isAccessory(l.title)) return false; // parity with the eBay/scraper paths
    if (l.price == null) return true; // keep unpriced (WTB / body-priced) posts
    if (lo != null && l.price < lo) return false;
    if (hi != null && l.price > hi) return false;
    return true;
  }).slice(0, 12);
}

// ---- best-effort per-IP rate limit (in-isolate) ---------------------------
// Cloudflare isolates are per-colo and ephemeral, so this bounds bursts rather
// than being a hard global cap. Backed up by the KV daily budget below.
const RL = new Map();
const RL_WINDOW_MS = 5 * 60 * 1000, RL_CAP = 30;
function rateLimited(ip, now) {
  if (!ip) return false;
  let arr = (RL.get(ip) || []).filter(function (t) { return now - t < RL_WINDOW_MS; });
  if (arr.length >= RL_CAP) { RL.set(ip, arr); return true; }
  arr.push(now);
  RL.set(ip, arr);
  if (RL.size > 5000) RL.clear();
  return false;
}

// ---- global daily eBay-call budget (KV) -----------------------------------
// A hard-ish global cap on eBay Browse calls/day, well under the 5000 quota, so
// no accidental loop or abuser can drain it and break listings for the day.
// Each passing call writes TWO KV keys (per-IP + global), so the daily WRITE
// count is the binding constraint on the free tier (~1000 writes/day): the budget
// is sized so 2×budget stays under that. Once capped we do a READ-ONLY check and
// perform ZERO further writes, so post-cap abuse can't exhaust the write quota.
// (KV is eventually consistent, so a fast burst can overshoot slightly — fine.)
const EBAY_DAILY_BUDGET = 450; // 2 writes/call × 450 = 900 < ~1000 free KV writes/day
const EBAY_IP_DAILY = 100; // reserve the shared budget: no single IP drains it all
function dayKey(now) { return "ebay:" + new Date(now).toISOString().slice(0, 10); }
// Read-only: is the global budget already spent? (no write → safe to gate first)
async function ebayBudgetSpent(env, now) {
  if (!env || !env.EBAY_BUDGET) return false;
  try { return (Number(await env.EBAY_BUDGET.get(dayKey(now))) || 0) >= EBAY_DAILY_BUDGET; }
  catch (e) { return false; } // KV read hiccup → allow (5000 eBay quota is the backstop)
}
// Best-effort increment of the global counter. Errors are swallowed — a KV write
// failure must NOT 502 the dashboard (the prior version's unguarded put did).
async function ebayBudgetInc(env, now) {
  if (!env || !env.EBAY_BUDGET) return;
  try {
    const key = dayKey(now);
    const cur = Number(await env.EBAY_BUDGET.get(key)) || 0;
    await env.EBAY_BUDGET.put(key, String(cur + 1), { expirationTtl: 172800 });
  } catch (e) { /* free-tier write cap or transient error → degrade, don't crash */ }
}
// Per-IP daily sub-cap so one abuser can't drain the whole 800 (and blank the
// dashboard) by spamming distinct queries: ~8 abusers now needed instead of 1.
// Checked BEFORE the global counter so a capped IP never consumes a global unit.
// KV write errors fail-open — the global budget is still the backstop.
async function ebayIpOk(env, ip, now) {
  if (!env || !env.EBAY_BUDGET || !ip) return true;
  const key = "ebayip:" + new Date(now).toISOString().slice(0, 10) + ":" + ip;
  try {
    const cur = Number(await env.EBAY_BUDGET.get(key)) || 0;
    if (cur >= EBAY_IP_DAILY) return false;
    await env.EBAY_BUDGET.put(key, String(cur + 1), { expirationTtl: 172800 });
  } catch (e) { return true; }
  return true;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const CORS = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const now = Date.now();
    const u = new URL(request.url);
    const q = (u.searchParams.get("q") || "").trim();
    const source = (u.searchParams.get("source") || "ebay").toLowerCase();
    const min = u.searchParams.get("min") || "";
    const max = u.searchParams.get("max") || "";
    const sub = u.searchParams.get("sub") || "";
    const cat = u.searchParams.get("cat") || "";

    // status>=400 responses are marked no-store so a transient upstream failure
    // (Reddit 429, eBay hiccup) isn't cached and replayed for 5 minutes.
    const json = function (obj, status) {
      const ok = !status || status < 400;
      return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({}, CORS, {
          "Content-Type": "application/json",
          "Cache-Control": ok ? "public, max-age=300" : "no-store",
        }),
      });
    };

    const ip = request.headers.get("cf-connecting-ip") || "";
    if (rateLimited(ip, now)) return json({ error: "rate limited — slow down" }, 429);
    if (!q) return json({ error: "missing q" }, 400);
    if (source !== "ebay" && source !== "reddit") return json({ source: source, error: "unknown source" }, 400);

    // Cache successful responses at the edge so repeat/identical loads cost 0
    // eBay Browse calls (protects the daily quota). Build the key from ONLY the
    // params the search logic actually reads — otherwise a junk param (&z=1,
    // jQuery's cache-buster &_=<ts>, …) spawns a distinct entry for a byte-
    // identical upstream request, defeating the cache and draining the budget.
    const cache = caches.default;
    const ck = new URL(u.origin + "/");
    ck.searchParams.set("source", source);
    ck.searchParams.set("q", q.toLowerCase());
    if (min.trim()) ck.searchParams.set("min", min.trim());
    if (max.trim()) ck.searchParams.set("max", max.trim());
    if (source === "reddit" && sub.trim()) ck.searchParams.set("sub", sub.trim().toLowerCase());
    if (source === "ebay" && cat.trim()) ck.searchParams.set("cat", cat.replace(/[^0-9]/g, ""));
    ck.searchParams.sort();
    const cacheKey = new Request(ck.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Re-apply CORS for THIS caller's origin — the cached copy baked in the
      // first caller's origin, which may differ from an allowed origin now.
      const h = new Headers(hit.headers);
      Object.keys(CORS).forEach(function (k) { h.set(k, CORS[k]); });
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    try {
      if (source === "ebay") {
        // Global cap FIRST as a read-only check — once spent we write nothing more,
        // so post-cap traffic can't burn the free-tier KV write quota.
        if (await ebayBudgetSpent(env, now))
          return json({ source: source, error: "daily eBay limit reached — try later" }, 429);
        // per-IP sub-cap: a drained IP is rejected before we increment the global.
        if (!(await ebayIpOk(env, ip, now)))
          return json({ source: source, error: "per-IP daily eBay limit reached — try later" }, 429);
        await ebayBudgetInc(env, now); // best-effort; KV errors won't 502 the page
      }
      const listings = source === "ebay"
        ? await ebaySearch(env, q, min, max, now, cat)
        : await redditSearch(sub, q, min, max);
      const resp = json({ source: source, listings: listings });
      if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    } catch (e) {
      // Log the full error server-side; return a generic message to the client
      // so upstream provider bodies / internal details aren't echoed out. Only the
      // friendly "rate-limited" message (Reddit, line ~248) passes through — do NOT
      // match on the bare "429" digits, which also appear in eBay's
      // "eBay search HTTP 429: <verbatim body>" and would leak that body.
      console.error("worker error [" + source + "]:", (e && e.stack) || e);
      const msg = /rate-limited/i.test(String(e && e.message)) ? String(e.message) : "upstream error";
      return json({ source: source, error: msg }, 502);
    }
  },
};
