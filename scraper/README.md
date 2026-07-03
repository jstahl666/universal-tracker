# Universal Tracker — homeserver scraper service

Live listings from marketplaces that block the Cloudflare Worker (datacenter IP
+ non-browser detection): **Craigslist, OfferUp, Mercari, Facebook**. It drives
a real Chromium via Playwright, so from a **residential IP** (the homeserver)
those sites treat it like a normal visitor. The tracker calls it as a live
source alongside the eBay/Reddit Worker.

```
Static page  →  Worker            (eBay, Reddit — API / open feed)
             →  scraper service   (Craigslist… — real browser, residential IP)
```

## API

```
GET /listings?source=craigslist&q=<query>&region=<sub>&min=<usd>&max=<usd>
    -> { source, listings:[ {title,price,currency,url,image,condition,location} ] }
GET /health -> { ok:true }
```

Sources implemented: `craigslist` (✅ working). Planned: `offerup`, `mercari`,
`facebook` — each added as `sources/<name>.js` and registered in `server.js`.

## Run locally

```bash
cd scraper
npm install
npx playwright install chromium
npm start           # listens on :8080 (PORT env to override)
curl "http://localhost:8080/listings?source=craigslist&q=steelcase%20chair&region=sfbay&max=250"
```

## Deploy on the homeserver (always-on)

1. Copy this `scraper/` folder to the homeserver, `npm install` +
   `npx playwright install chromium`.
2. Run it windowless/at-boot (Task Scheduler with `node server.js`, or `pm2`).
3. Expose it publicly with **Cloudflare Tunnel**:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
   (named tunnel for a stable hostname if a Cloudflare domain is available;
   otherwise a quick tunnel prints a temporary `*.trycloudflare.com` URL.)
4. Put that HTTPS hostname in `watchlist.json` → `config.scraperProxy`, commit.
   The tracker then shows live Craigslist (etc.) cards next to eBay.

## Notes

- Persistent browser context is reused across requests for speed; fonts/media
  are blocked, images kept (thumbnails).
- Price range is applied both via the site's URL params and re-checked
  numerically server-side.
- Craigslist renders results client-side into `a.posting-title` inside
  `.gallery-card`; selectors live in `sources/craigslist.js`.
