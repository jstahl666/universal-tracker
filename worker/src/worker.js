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

async function ebaySearch(env, q, min, max, now) {
  const token = await ebayToken(env, now);
  const filters = ["priceCurrency:USD"];
  const pf = priceFilter(min, max);
  if (pf) filters.push(pf);
  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + "?q=" + encodeURIComponent(q)
    + "&limit=10"
    + "&sort=price"
    + "&filter=" + encodeURIComponent(filters.join(","));
  const r = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!r.ok) throw new Error("eBay search HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  return (j.itemSummaries || []).map(function (it) {
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
      if (source === "ebay") return json({ source: source, listings: await ebaySearch(env, q, min, max, now) });
      if (source === "reddit") return json({ source: source, listings: await redditSearch(sub, q, min, max) });
      return json({ source: source, error: "unknown source: " + source }, 400);
    } catch (e) {
      return json({ source: source, error: String((e && e.message) || e) }, 502);
    }
  },
};
