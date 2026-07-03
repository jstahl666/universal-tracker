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

  return await page.evaluate(() => {
    function priceOf(s) {
      const m = (s || "").match(/\$\s?([\d,]+(?:\.\d{2})?)/);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    }
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
      // .meta leads with a date/time-ago token then the location, e.g.
      // "6/18san jose downtown" or "1h agosunnyvale" — strip the leading token.
      let loc = "";
      if (metaEl) {
        loc = metaEl.textContent.replace(/·/g, " ")
          .replace(/^\s*(?:\d+\/\d+|\d+\s*[a-z]+\s*ago)\s*/i, "").trim();
      }
      out.push({
        title: title,
        price: priceOf(priceEl ? priceEl.textContent : ""),
        currency: "USD",
        url: a.href,
        image: img ? (img.src || img.getAttribute("data-src") || "") : "",
        condition: "",
        location: loc,
      });
    });
    return out;
  });
}
