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
  (title/price/image/link) via app-only OAuth — the one reliable source. Facebook/OfferUp/
  Mercari/Amazon have no usable API and stay as click-out buttons.

- **Craigslist inline = abandoned (2026-07-02).** Tested server-side fetch of Craigslist
  search RSS (`&format=rss`): returns a `403` "Your request has been blocked" HTML page
  even from a residential IP. Craigslist blocks programmatic access at the IP+behavior
  level; a Worker's data-center IP is blocked harder. Reverted to click-out button only.

- **Reddit inline = shipped, but flaky (2026-07-02).** Reddit's `.json` search API hard-403s
  non-OAuth clients now, but the `.rss` (Atom) feed is still open — so the worker fetches
  that and parses the XML. Works, but Reddit rate-limits (429) per IP, and a Worker shares
  a data-center IP → intermittent 429s in production. Front-end already degrades to a
  friendly note on error, so it's low-risk. Price is regex'd from the [WTS] post title
  (null when the price lives only in the body). Kept because it costs little and the audio
  used-gear markets (r/AVexchange, r/hardwareswap) are exactly where headphone deals live.

- **Net: eBay is the only fully reliable inline source.** The "show listings inline"
  feature is really an eBay feature; Reddit is a best-effort bonus, everything else is a
  deep-link button. This matches what the marketplaces actually allow.

- **Worker URL lives in `watchlist.json` config**, not hardcoded. If `config.listingsProxy`
  is unset the page silently falls back to buttons-only, so the site never depends on the
  Worker being up.

- **"PC + Android app" = PWA, not Flutter (2026-07-06).** Asked to make it an app "like the
  task widget." Rejected full-native Flutter: it would throw away the battle-tested HTML UI
  (8 stress rounds, ~51 bugs) and force a new sync backend to replace the manual-GitHub flow,
  for a tracker that already runs in any browser on phone + PC. Also rejected a Flutter
  webview wrapper (real .apk/.exe but no real gain over an installable web page). Shipped a
  **PWA**: `manifest.webmanifest` + `service-worker.js` + `icons/`. Installs as a home-screen
  icon on Android and a desktop app on Windows (Chrome/Edge → Install), opens standalone,
  works offline. Same URL, zero rewrite, no new server.

- **SW caching strategy.** App shell (icons/manifest) cache-first + precached. Navigation
  and `watchlist.json` network-first (so deploys + data edits show when online, cached copy
  serves offline). Cross-origin listings-proxy calls are NOT intercepted — they stay live and
  the app degrades on its own. GOTCHA fixed in test: the app fetches `watchlist.json?cb=<ts>`
  (cache-bust), so the SW stores it under a query-stripped canonical key and reads back with
  `{ignoreSearch:true}` — otherwise the offline fallback missed and showed 0 items. Verified
  end-to-end offline (server killed → 17 items still render). Cache version `ut-v2`.
