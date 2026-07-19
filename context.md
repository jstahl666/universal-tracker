# context — universal-tracker

## What this is
General-purpose "track any item" dashboard. Single static HTML page (`index.html`),
vanilla JS, no backend. Data in `watchlist.json`, synced via a manual GitHub-edit flow.

## Origin
A generic tracker (`tracker.html`) had grown inside the **chair-tracker** repo — it was
already domain-agnostic but seeded with chair defaults and wired to chair-tracker's
Slickdeals deal feed. It was pulled out into its own clean project.

Stripped for this fork:
- chair seed items (DEFAULTS.items now `[]`)
- built-in deal feed (loadDeals, ownerOf/dealsFor/hitCount, "in range" pills, deal rows,
  feedModel/keywords advanced field, "Raw deals" link)
- REPO pointer → `jstahl666/universal-tracker`, LS_KEY → `universal-tracker.draft.v1`

Kept: item CRUD, categories, status, price range, link, notes, marketplace deep-link search
(eBay / Facebook / Craigslist / OfferUp / Mercari / Google), local-first + Save-to-GitHub sync.

## Layout
- `index.html` — the app (also the Pages entry point)
- `watchlist.json` — the data
- `.nojekyll` — Pages serves verbatim

## Repo / hosting
- GitHub: jstahl666/universal-tracker (public, for Pages)
- Live: https://jstahl666.github.io/universal-tracker/

## Design
Follows repo dark UI palette: --bg #0F0F1A, --card #1A1B2E, --accent #315CFD (Bravado Blue).
