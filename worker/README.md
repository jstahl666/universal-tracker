# Listings proxy — Cloudflare Worker

The dashboard is a static page, so it can't fetch marketplace listings directly
(CORS + auth + bot-blocking). This Worker runs server-side and returns clean
JSON the page renders as cards.

**Endpoint:** `GET /?source=<src>&q=<query>&min=<usd>&max=<usd>[&sub=<subreddit>]`

## Sources (what actually works server-side)

| source | status | notes |
|--------|--------|-------|
| `ebay` | ✅ solid | Browse API, app-only OAuth. Needs keys (below). |
| `reddit` | ⚠️ works, flaky | Uses the `.rss` (Atom) feed — the `.json` API hard-403s non-OAuth clients. Reddit rate-limits (429) per IP; a Worker's shared IP hits that intermittently, so the page degrades to a friendly note. Needs `&sub=<subreddit>`. Price is regex'd from the post title ([WTS] threads); null when the price is only in the body. |
| ~~craigslist~~ | ❌ not viable | Craigslist hard-blocks programmatic search/RSS fetches (`403` "Your request has been blocked") even from a residential IP — worse from a Worker's data-center IP. Stays a **click-out button** in the UI, never inline. |

Everything else (Facebook, OfferUp, Mercari, Amazon) has no usable open API and
stays a click-out button too. **eBay is the only fully reliable inline source.**

---

## One-time setup

### 1. Get a free eBay developer keyset
1. Sign up at https://developer.ebay.com/ (use your normal eBay login).
2. Go to **Develop → Application Keysets**.
3. Under the **Production** keyset, note two values:
   - **App ID (Client ID)** → becomes `EBAY_CLIENT_ID`
   - **Cert ID (Client Secret)** → becomes `EBAY_CLIENT_SECRET`
   No OAuth redirect / user consent needed — this uses the app-only
   (client-credentials) flow, which the Browse API supports.

### 2. Get a free Cloudflare account + install wrangler
1. Sign up at https://dash.cloudflare.com/sign-up (free tier is enough).
2. Install the CLI (Node required):  `npm install -g wrangler`
3. Log in:  `wrangler login`  (opens a browser to authorize)

### 3. Deploy
From this `worker/` folder:

```bash
wrangler secret put EBAY_CLIENT_ID       # paste your App ID
wrangler secret put EBAY_CLIENT_SECRET   # paste your Cert ID
wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.
`https://universal-tracker-listings.<your-subdomain>.workers.dev`

### 4. Point the dashboard at it
Add the Worker URL to `watchlist.json` (top-level `config`):

```json
"config": { "craigslistRegion": "sfbay", "listingsProxy": "https://universal-tracker-listings.<you>.workers.dev" }
```

Commit that, and the dashboard shows live eBay listings under each item.
(Give me the URL and I'll wire + test it.)

---

## Test locally without the dashboard
```bash
wrangler dev --local
# then in another shell:
curl "http://localhost:8787/?source=ebay&q=hifiman%20sundara&max=199"   # needs keys
curl "http://localhost:8787/?source=reddit&sub=hardwareswap&q=headphones"  # no keys
```
Note: `wrangler dev` fetches from *your* IP, so `reddit` works more reliably
locally than once deployed (Worker shares a data-center IP → more 429s).

## Notes
- Free tiers: Cloudflare Workers = 100k requests/day; eBay Browse API = 5k calls/day.
  On-demand per item-open, you'll use a tiny fraction.
- **eBay** and **reddit** are wired. Craigslist was tried and abandoned
  (hard-blocked, see the sources table). Adding a new source = one more
  `source` branch in `src/worker.js`.
