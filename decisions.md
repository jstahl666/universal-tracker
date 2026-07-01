# decisions — universal-tracker

- **Own repo, not a folder in chair-tracker.** The tracker was domain-agnostic but living
  in chair-tracker made it look chair-specific and coupled it to that repo's deal feed.
  Clean split = clearer purpose + independent Pages URL.

- **Dropped the built-in deal feed.** chair-tracker's feed matching (scraping its own
  `index.html`, keyword-matching deals to items) only works because a Python watcher
  populates that feed. A generic tracker has no such watcher, so the whole feed layer was
  dead weight. Removed it; marketplace deep-link search is the universal replacement.

- **Static HTML + manual GitHub sync, no backend.** Same pattern as the original. Zero
  hosting cost, works as a plain file, syncs across devices through a committed JSON.
  Trade-off: saving is a copy-paste-into-GitHub step, not one click. Accepted for simplicity.

- **`index.html` IS the app** (not a separate `tracker.html`). With no deal feed there's no
  second page to reserve the root for, so the app takes the Pages root directly.

- **Public repo.** Required for free GitHub Pages.

- **Live listings need a backend; static page can't fetch them.** Browsers block
  cross-origin fetches to eBay/Craigslist/etc (CORS), and those sites need auth / block
  bots. To show listings inline we added a tiny **Cloudflare Worker** (`worker/`) that
  queries server-side and returns clean JSON. Chosen over Fly/homeserver: free, always-on,
  zero-maintenance, ideal for an on-demand proxy. Load is **live per item-open**, not a
  scheduled feed — always current, no cron.

- **eBay first, others incremental.** eBay Browse API returns clean structured listings
  (title/price/image/link) via app-only OAuth — the one reliable source. Craigslist (RSS)
  and Reddit audio markets come next as extra `source` branches. Facebook/OfferUp/Mercari/
  Amazon have no usable API and stay as click-out buttons.

- **Worker URL lives in `watchlist.json` config**, not hardcoded. If `config.listingsProxy`
  is unset the page silently falls back to buttons-only, so the site never depends on the
  Worker being up.
