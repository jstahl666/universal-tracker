# todo — universal-tracker

## Done
- [x] Fork generic tracker out of chair-tracker
- [x] Strip chair seed data + built-in deal feed
- [x] Repoint config at jstahl666/universal-tracker
- [x] Scaffold project folder (README, context, decisions, .gitignore)
- [x] Create public GitHub repo + push
- [x] Enable GitHub Pages

## Live listings (in progress)
- [x] Section 1 — eBay: Cloudflare Worker proxy (worker/) + front-end card rendering
- [ ] **WAITING ON JEREMY:** eBay dev keyset + Cloudflare account → deploy Worker (see worker/README.md) → give me the Worker URL to wire into watchlist.json config.listingsProxy
- [ ] Section 2 — Craigslist (RSS → JSON, new `source` branch in worker.js)
- [ ] Section 3 — Reddit audio markets (r/AVexchange, r/hardwareswap) if JSON cooperates
- [ ] Facebook/OfferUp/Mercari/Amazon stay click-out buttons (no API)

## Next / maybe
- [ ] Consider more marketplaces (StockX/Reverb/Discogs) or making the list configurable
- [ ] Optional: export/import JSON without the GitHub round-trip
