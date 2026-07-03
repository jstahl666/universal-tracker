// Universal Tracker — listings proxy (Cloudflare Worker)
//
// The dashboard is a static page, so its JavaScript can't fetch marketplace
// listings directly (CORS + auth + bot-blocking). This Worker runs server-side
// and returns clean normalized JSON the page can render as cards.
//
// Sources:
//   ebay        — eBay Browse API (needs credentials; app-only OAuth)
//   craigslist  — Craigslist search RSS feed (no auth); needs &region=<subdomain>
//   reddit      — Reddit search JSON (no auth); needs &sub=<subreddit>
//
// Endpoint:  GET /?source=<src>&q=<query>&min=<usd>&max=<usd>[&region=][&sub=]
// Response:  { source, listings:[ {title,price,currency,url,image,condition,location} ] }
//            or { source, error }
//
// Secrets (set with `wrangler secret put ...`) — eBay only:
//   EBAY_CLIENT_ID      — eBay App ID  (Client ID, Production keyset)
//   EBAY_CLIENT_SECRET  — eBay Cert ID (Client Secret, Production keyset)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// eBay OAuth app token (client-credentials grant). Cached in-isolate until it
// nears expiry so we don't mint one per request.
let tokenCache = { token: null, exp: 0 };

async function ebayToken(env, now) {
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("eBay credentials not set (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)");
  }
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
}

function priceFilter(min, max) {
  min = (min || "").trim();
  max = (max || "").trim();
  if (min && max) return "price:[" + min + ".." + max + "]";
  if (max) return "price:[.." + max + "]";
  if (min) return "price:[" + min + "..]";
  return "";
}

// Accessory/parts noise filter. Sellers list ear pads, cables, headbands,
// casters, etc. INSIDE the real product category and — sorted by price — those
// cheap accessories bury the actual items. Drop any title that reads as an
// accessory/part rather than the product itself. Word-boundary matched so e.g.
// "cushion" doesn't nuke a chair whose model name legitimately contains a word.
// NOTE: deliberately excludes "mesh" (all-mesh chairs) to avoid false drops.
const ACCESSORY_RX = new RegExp("\\b(" + [
  // headphone accessories/parts
  "ear\\s?pads?", "pads?", "cushions?", "ear\\s?cushions?", "covers?",
  "cables?", "cords?", "connectors?", "plugs?", "adapters?", "adaptors?",
  "headbands?", "foam", "cushioning", "replacement", "spare",
  "decorative\\s?ring", "rings?", "grommets?", "mounts?", "stands?",
  "hangers?", "hooks?", "holders?", "cases?", "pouch", "bag",
  "stickers?", "decals?", "skins?", "wraps?", "kits?",
  "transmitters?", "chargers?", "docks?", "receivers?",
  // chair accessories/parts
  "casters?", "wheels?", "cylinders?", "pistons?", "arm\\s?rests?", "armrests?",
  "glides?", "screws?", "bolts?", "washers?", "parts?",
  "headrests?", "seat\\s?pans?", "yokes?", "assembl(?:y|ies)", "springs?",
  "spacers?", "knobs?", "handles?", "torsion", "instructions?", "manuals?",
  "gas\\s?lift", "sector\\s?gear", "tilt\\s?(?:kit|cam|knob|engine|handle)",
  "arm\\s?pads?", "armpads?", "slip\\s?covers?", "slipcovers?",
  "back\\s?frames?", "frames?", "backrests?", "back\\s?rests?", "seat\\s?backs?",
  "mechanisms?", "controls?", "pieces?", "cubicles?", "panels?"
].join("|") + ")\\b", "i");

async function ebaySearch(env, q, min, max, now, cat, debug) {
  const token = await ebayToken(env, now);
  const filters = ["priceCurrency:USD"];
  // Implicit price floor: replacement parts/accessories are always a small
  // fraction of the product's price. When a max is set but no explicit min,
  // floor the search at 15% of max so $2 springs / $10 ear pads never bury the
  // real listings — while any realistic deal stays well above the floor.
  const FLOOR_FRAC = 0.15;
  const maxN = Number((max || "").trim());
  let effMin = (min || "").trim();
  if (!effMin && maxN > 0) effMin = String(Math.round(maxN * FLOOR_FRAC));
  const pf = priceFilter(effMin, max);
  if (pf) filters.push(pf);
  // Restrict to a leaf category (e.g. Headphones) so accessories/parts that
  // live in OTHER categories drop out. Sellers still cross-list some accessories
  // INTO the product category, so ACCESSORY_RX below catches the rest.
  cat = (cat || "").trim().replace(/[^0-9]/g, "");
  // Fetch a wide pool (50) so that after filtering accessories out we still have
  // a healthy set of real listings to show.
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + "?q=" + encodeURIComponent(q)
    + "&limit=50"
    + "&sort=price"
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
  return (j.itemSummaries || []).filter(function (it) {
    return !ACCESSORY_RX.test(it.title || "");
  }).slice(0, 12).map(function (it) {
    const img = (it.image && it.image.imageUrl) ||
      (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) || "";
    const out = {
      title: it.title || "",
      price: it.price ? Number(it.price.value) : null,
      currency: (it.price && it.price.currency) || "USD",
      url: it.itemWebUrl || "",
      image: img,
      condition: it.condition || "",
      location: (it.itemLocation && (it.itemLocation.city || it.itemLocation.stateOrProvince || it.itemLocation.country)) || "",
    };
    // debug=1 → surface the item's categories so we can discover the right
    // category_ids to hardcode in the frontend, then this flag is dropped.
    if (debug) out._cats = (it.categories || []).map(function (c) { return c.categoryId + ":" + c.categoryName; });
    return out;
  });
}

// Craigslist NOTE: there is deliberately no Craigslist source here. Craigslist
// hard-blocks programmatic fetches of its search/RSS at the IP+behavior level
// (returns an HTML "Your request has been blocked" page, 403) even from a
// residential IP — and a Worker's data-center IP is blocked more reliably still.
// So Craigslist stays a click-out button in the UI (see MARKETS in index.html).

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
// Buy/sell subreddits (r/AVexchange, r/hardwareswap) post [WTS]/[WTB] threads;
// price lives in the title text, not a structured field, so we regex it out.
// Reddit's .json API hard-403s non-OAuth clients, but the .rss (Atom) feed is
// still open — so we use that and parse the XML. Reddit rate-limits (429) per
// IP aggressively, and a Worker shares a data-center IP with other traffic, so
// expect intermittent 429s in production; the page degrades to a friendly note.
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
    if (l.price == null) return true; // keep unpriced (WTB / body-priced) posts
    if (lo != null && l.price < lo) return false;
    if (hi != null && l.price > hi) return false;
    return true;
  }).slice(0, 12);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const now = Date.now();
    const u = new URL(request.url);
    const q = (u.searchParams.get("q") || "").trim();
    const source = (u.searchParams.get("source") || "ebay").toLowerCase();
    const min = u.searchParams.get("min") || "";
    const max = u.searchParams.get("max") || "";
    const sub = u.searchParams.get("sub") || "";
    const cat = u.searchParams.get("cat") || "";
    const debug = u.searchParams.get("debug") === "1";
    const json = function (obj, status) {
      return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({}, CORS, {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        }),
      });
    };
    if (!q) return json({ error: "missing q" }, 400);
    try {
      if (source === "ebay") return json({ source: source, listings: await ebaySearch(env, q, min, max, now, cat, debug) });
      if (source === "reddit") return json({ source: source, listings: await redditSearch(sub, q, min, max) });
      return json({ source: source, error: "unknown source: " + source }, 400);
    } catch (e) {
      return json({ source: source, error: String((e && e.message) || e) }, 502);
    }
  },
};
