/* Universal Tracker — service worker
   Strategy:
   - App shell (icons, manifest): cache-first, precached on install.
   - Navigation + watchlist.json: network-first, fall back to cache offline
     so new deploys / data edits are seen when online but the app still opens offline.
   - Cross-origin (Cloudflare Worker live listings, eBay images): NOT intercepted —
     they must stay live and are allowed to fail gracefully by the app itself.
*/
const VERSION = "ut-v2";
const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./watchlist.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin requests; let the browser deal with the live-listings proxy etc.
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === "navigate";
  const isData = url.pathname.endsWith("/watchlist.json");

  if (isData) {
    // network-first, but the app cache-busts with ?cb=<ts>. Store under a
    // canonical (query-stripped) key so there's ONE entry, and read it back
    // with ignoreSearch so the offline fallback matches despite the changing query.
    const canonical = url.origin + url.pathname;
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(canonical, copy));
          return res;
        })
        .catch(() =>
          caches.match(canonical).then((hit) =>
            hit || caches.match(req, { ignoreSearch: true })
          )
        )
    );
    return;
  }

  if (isNav) {
    // network-first for the page, fall back to the cached shell offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  // cache-first for other same-origin assets (icons, manifest)
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    }))
  );
});
