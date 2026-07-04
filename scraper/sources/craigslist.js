// Craigslist scraper. Craigslist 403s curl/datacenter clients and renders its
// search results with JS, so we drive a real browser page. Region is a
// craigslist subdomain (e.g. "sfbay"); q/min/max are the query + USD range.
export async function craigslist(page, { q, region, min, max }) {
  region = (region || "sfbay").replace(/[^a-z0-9]/gi, "") || "sfbay";
  let url = "https://" + region + ".craigslist.org/search/sss?query=" + encodeURIComponent(q) + "&sort=priceasc";
  if (min) url += "&min_price=" + encodeURIComponent(min);
  if (max) url += "&max_price=" + encodeURIComponent(max);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Results render client-side; each listing title is an <a.posting-title>.
  // Wait for the first one (or bail after a grace period if there are no hits).
  await page.waitForSelector("a.posting-title", { timeout: 12000 }).catch(() => {});

  // Craigslist lazy-loads gallery thumbnails only when a card scrolls into view —
  // before that the <img src> is a 1x1 placeholder data-URI. Scroll through the
  // results so the real images.craigslist.org URLs get swapped in, then let them
  // settle. (The scrape route keeps images; only font/media are aborted.)
  await page.evaluate(async () => {
    await new Promise((res) => {
      let y = 0;
      const iv = setInterval(() => {
        window.scrollBy(0, 1200); y += 1200;
        if (y >= document.body.scrollHeight || y > 16000) { clearInterval(iv); res(); }
      }, 90);
    });
    await new Promise((r) => setTimeout(r, 600));
  });

  return await page.evaluate(() => {
    function priceOf(s) {
      const m = (s || "").match(/\$\s?([\d,]+(?:\.\d{2})?)/);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    }
    // .meta leads with a date/time-ago token — "6/18" (a date) or "1h ago"/"3d ago"
    // (relative). Capture it as `posted` (how old the listing is) AND strip it off
    // to isolate the location.
    const DATE_RX = /^\s*(\d{1,2}\/\d{1,2}|\d+\s*[a-z]+\s*ago)/i;
    const seen = {};
    const out = [];
    // Titles are <a.posting-title>; the surrounding .gallery-card holds the
    // price (.priceinfo), meta/location (.meta), and thumbnail (img).
    document.querySelectorAll("a.posting-title").forEach(function (a) {
      const title = a.textContent.trim();
      if (!title || seen[a.href]) return;
      seen[a.href] = 1;
      const card = a.closest(".gallery-card") || a.parentElement;
      const priceEl = card && card.querySelector(".priceinfo");
      const metaEl = card && card.querySelector(".meta");
      const img = card && card.querySelector("img");
      let posted = "", loc = "";
      if (metaEl) {
        const mt = metaEl.textContent.replace(/·/g, " ").replace(/\s+/g, " ").trim();
        const dm = mt.match(DATE_RX);
        posted = dm ? dm[1].replace(/\s+/g, " ").trim() : "";
        loc = mt.replace(DATE_RX, "").trim();
      }
      // Only accept a REAL image URL — reject the lazy-load placeholder data-URI so
      // the front-end can show "image unavailable" for genuinely image-less posts.
      let image = "";
      if (img) {
        const cand = img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || "";
        if (/^https?:\/\//i.test(cand)) image = cand;
      }
      out.push({
        title: title,
        price: priceOf(priceEl ? priceEl.textContent : ""),
        currency: "USD",
        url: a.href,
        image: image,
        condition: "",
        location: loc,
        posted: posted,
      });
    });
    return out;
  });
}
