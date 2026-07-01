// Universal Tracker — listings proxy (Cloudflare Worker)
//
// The dashboard is a static page, so its JavaScript can't fetch marketplace
// listings directly (CORS + auth + bot-blocking). This Worker runs server-side,
// holds the eBay API credentials, queries eBay's Browse API, and returns clean
// normalized JSON the page can render as cards.
//
// Endpoint:  GET /?source=ebay&q=<query>&min=<usd>&max=<usd>
// Response:  { source, listings:[ {title,price,currency,url,image,condition,location} ] }
//            or { source, error }
//
// Secrets (set with `wrangler secret put ...`):
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const now = Date.now();
    const u = new URL(request.url);
    const q = (u.searchParams.get("q") || "").trim();
    const source = (u.searchParams.get("source") || "ebay").toLowerCase();
    const min = u.searchParams.get("min") || "";
    const max = u.searchParams.get("max") || "";
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
      return json({ source: source, error: "unknown source: " + source }, 400);
    } catch (e) {
      return json({ source: source, error: String((e && e.message) || e) }, 502);
    }
  },
};
