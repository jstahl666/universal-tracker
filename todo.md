# todo — universal-tracker

## Done
- [x] Fork generic tracker out of chair-tracker
- [x] Strip chair seed data + built-in deal feed
- [x] Repoint config at jstahl666/universal-tracker
- [x] Scaffold project folder (README, context, decisions, .gitignore)
- [x] Create public GitHub repo + push
- [x] Enable GitHub Pages

## Live listings
- [x] Section 1 — eBay: Cloudflare Worker proxy (worker/) + front-end card rendering
- [x] Section 3 — Reddit audio markets (r/AVexchange, r/hardwareswap): `.rss` feed source (JSON is 403'd), tested via `wrangler dev`
- [x] Section 2 — Craigslist: TESTED + ABANDONED (server-side 403 "blocked"; stays a button). See decisions.md
- [x] Facebook/OfferUp/Mercari/Amazon stay click-out buttons (no API)
- [ ] **WAITING ON EBAY:** dev keyset approval (Jeremy applied). Then: `wrangler login` → `wrangler secret put` both keys → `wrangler deploy` → give me the Worker URL to wire into watchlist.json config.listingsProxy. Reddit will start working the moment the Worker is deployed too (no keys needed).

## Next / maybe
- [ ] Consider more marketplaces (StockX/Reverb/Discogs) or making the list configurable
- [ ] Optional: export/import JSON without the GitHub round-trip
