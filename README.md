# universal-tracker

A single self-contained HTML dashboard for tracking **anything** you're keeping an eye on —
gear you want to buy, subscriptions, wishlist items, whatever. No backend, no build step.

Forked from the generic `tracker.html` that grew inside chair-tracker, stripped of all
chair-specific seed data and the built-in Slickdeals feed. Pure item tracker.

**Live:** https://jstahl666.github.io/universal-tracker/

## What it does

- **Add / edit / remove items** with generic fields: Name, Category (freeform + autocomplete),
  Status (Active / Paused / Done), search query, Min/Max price, Link, Notes.
- **Sidebar + "All items" grid** — every item as a tile, chip-tagged by category and status.
- **Live marketplace search** per item — one-click deep-links, pre-filled with your search
  text and (where supported) price range. Every item hits the universal sources: **eBay,
  Facebook Marketplace, Craigslist** (region set in the toolbar)**, OfferUp, Mercari, Amazon,
  Slickdeals, Google Shopping**. Category-specific sources add on top — **Headphones** also
  get **r/AVexchange, r/hardwareswap, and Head-Fi** (audiophile used-gear markets). Add a new
  category source by editing the `MARKETS` list (`all:true` = everywhere, `cats:[...]` = gated).
- **Local-first editing** — edits save to your browser instantly (yellow "unsaved" banner).
  **Save to GitHub** copies the JSON and opens the `watchlist.json` editor so your list syncs
  across every device.

## Data

All items live in `watchlist.json`. The page reads it on load; the **Save to GitHub** flow
writes it back. That's the whole sync mechanism — no server.

## Run locally

Just open `index.html` in a browser. (Marketplace links and editing work offline; the
GitHub-sync step needs the file to be committed to the repo.)

## Deploy

GitHub Pages serves the repo root. `.nojekyll` is present so Pages ships the files verbatim.
Any push to `main` updates the live page.
