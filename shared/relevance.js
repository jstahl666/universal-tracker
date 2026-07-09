// Universal Tracker — listing-relevance gate (shared server-side module).
//
// The single hardest piece of domain logic in the tracker answers one question:
//   "Given a user's query and a marketplace listing (title + price), is this a
//    relevant WHOLE-PRODUCT listing worth showing?"
//
// It was copy-pasted almost verbatim into two runtimes — the Cloudflare Worker
// (eBay/Reddit) and the homeserver Playwright scraper (Craigslist/…) — and kept
// in sync only by hand-written "must not drift" comments. This module is the one
// place that logic lives. Both runtimes are ESM and bundle relative imports
// (esbuild for the Worker, native ESM for Node), so both import this file.
//
// Interface (deep — a lot of regex/heuristic behind a tiny surface):
//   modelToken(query)            -> distinctive model/brand token to gate on
//   matchesModel(title, model)   -> does the title name that model?  (6xx wildcard)
//   isAccessory(title)           -> is this a part/accessory, not a whole product?
//   keepListing(title, price, {model, min, max}) -> full gate for a listing
//
// eBay applies price at the API level and composes matchesModel + !isAccessory
// itself; Reddit and the scraper use keepListing for the whole title+price gate.

// ---- accessory / parts filter --------------------------------------------
// Almost every part word (pads, case, headrest, casters…) ALSO appears in real
// full-product listings ("HD600 with new pads", "Leap with headrest"), so a
// blanket "contains the word" drop nukes real inventory. Two tiers instead:
//   STRONG  — words that essentially never appear on a whole product → drop anywhere
//   WEAK    — ambiguous nouns → drop only when the title is accessory-LED
//             (starts with the word) or uses an "<word> … for" construction.
const PART_STRONG = [
  "replacement", "spare", "for\\s+parts", "torsion", "gas\\s?lift",
  "sector\\s?gear", "grommets?", "tilt\\s?(?:kit|cam|knob|engine|handle)",
  "instructions?", "owners?\\s?manual", // docs, never a whole product
  // repair KIT/LINE/CABLE/PART = a part; a bare "repair"/"repairs" is NOT (it
  // appears on whole products, e.g. "No Repairs Needed") so don't drop on it.
  "repair\\s?(?:kits?|lines?|cables?|cords?|parts?)",
];
const PART_WEAK = [
  "ear\\s?pads?", "pads?", "cushions?", "covers?", "cables?", "cords?",
  "connectors?", "plugs?", "adapters?", "adaptors?", "headbands?", "foam",
  "decorative\\s?rings?", "rings?", "mounts?", "stands?", "hangers?", "hooks?",
  "holders?", "cases?", "pouch", "bags?", "skins?", "wraps?", "kits?",
  "transmitters?", "chargers?", "docks?", "receivers?", "casters?", "wheels?",
  "cylinders?", "pistons?", "glides?", "screws?", "bolts?", "washers?", "parts?",
  "springs?", "knobs?", "handles?", "manuals?", "frames?",
  "backrests?", "back\\s?rests?", "back\\s?frames?", "mechanisms?", "controls?",
  "pieces?", "panels?", "cubicles?", "headrests?", "seat\\s?pans?",
  "seat\\s?backs?", "seats?", "yokes?", "spacers?", "arm\\s?rests?", "armrests?",
  "arm\\s?pads?", "armpads?", "slip\\s?covers?", "slipcovers?", "stickers?", "decals?",
];
const STRONG_RX = new RegExp("\\b(?:" + PART_STRONG.join("|") + ")\\b", "i");
const WEAK_ANY_RX = new RegExp("\\b(?:" + PART_WEAK.join("|") + ")\\b", "i");
// accessory-led: optional count/qualifier, then a weak word near the start
const WEAK_LEAD_RX = new RegExp(
  "^\\s*(?:\\(?\\d+\\)?\\s+)?(?:new|used|oem|genuine|original|premium|pair\\s+of|set\\s+of|lot\\s+of|pair|set|lot|for)?\\s*(?:" +
  PART_WEAK.join("|") + ")\\b", "i");
// "<weak word> … for <BRAND or MODEL>" — e.g. "Ear Pads for Sennheiser HD650",
// "Cable for HE4XX". The accessory signal is what FOLLOWS "for": a brand name or a
// model-number token means the item is an accessory FOR that product. A use-case
// or spec after "for" ("cable for amp", "casters for carpet", "case for travel",
// "chair for sale") is a WHOLE product describing itself, so it must NOT match.
// Matching on the positive "for <brand/model>" target (rather than a position
// guard + a hand-maintained use-case denylist) correctly spares both word-named
// products ("Aeron … casters for carpet") and model-led products ("HD650 … cable
// for amp") without needing to know the model's position in the title.
const BRAND_WORDS = [
  "sennheiser", "hifi\\s?man", "herman\\s?miller", "herman", "miller", "steelcase",
  "akg", "beyerdynamic", "beyer", "audeze", "focal", "grado", "fostex", "denon",
  "meze", "koss", "sony", "bose", "philips", "drop", "massdrop", "dan\\s?clark",
  "audio\\s?technica", "sivga", "moondrop", "hifiman", "haworth", "humanscale", "knoll",
];
// after "for": a known brand, OR a model-number token (HD650, K712, HE4XX)
const FOR_TARGET = "(?:" + BRAND_WORDS.join("|") + "|[a-z]+\\d[a-z0-9]*|\\d{3,})";
const WEAK_FOR_RX = new RegExp(
  "\\b(?:" + PART_WEAK.join("|") + ")\\b[\\s\\S]{0,20}\\bfor\\b\\s+" + FOR_TARGET + "\\b", "i");
// first MODEL token — 3+ digits (650, 1990) or a letter+digit blend (HD650,
// K712, V2). Excludes bare spec numbers like the "8" in "8 Core … Cable".
const MODEL_NUM_RX = /\b(?:[a-z]+\d[a-z0-9]*|\d{3,})\b/i;

// A title is an accessory when the accessory noun leads the product name rather
// than trailing it. Products read "<Brand> <Model> … <accessory>"; accessories
// read "<accessory> … for <Brand> <Model>" or "<accessory> - <Brand> <Model>".
export function isAccessory(title) {
  const t = title || "";
  if (STRONG_RX.test(t)) return true;
  if (WEAK_LEAD_RX.test(t)) return true;
  const m = t.match(MODEL_NUM_RX);
  // weak accessory word appearing BEFORE the first model-number token → led by
  // the accessory (e.g. "Custom Headphone Cable - AKG K712"). A weak word AFTER
  // the model is just a whole product mentioning an accessory ("HD650 w/ case").
  if (m && m.index > 0 && WEAK_ANY_RX.test(t.slice(0, m.index))) return true;
  // "<weak> … for <brand/model>" is self-sufficient (the target after "for" must
  // be a brand or model token), so no position guard is needed: it fires only on
  // genuine "accessory FOR a product" titles regardless of where the model sits.
  if (WEAK_FOR_RX.test(t)) return true;
  return false;
}

// ---- model-relevance gate --------------------------------------------------
// Accessories with NO model number that don't lead with the accessory word slip
// past isAccessory (e.g. "NewFantasia … Balanced Headphone Cable" for a HiFiMan
// query). A relevance gate — does the title actually name the queried model? —
// drops off-topic parts that a category filter cross-lists in.
// Generic category filler that must NOT be chosen as the distinctive token:
// "steelcase office chair" should gate on "steelcase", not "chair" (which would
// drop every real "Steelcase Leap V2" whose title omits the word "chair").
const GENERIC_WORDS = new Set([
  "office", "chair", "chairs", "desk", "desks", "seat", "seating", "stool",
  "headphone", "headphones", "earphone", "earphones", "headset", "monitor",
  "monitors", "speaker", "speakers", "ergonomic", "mesh", "task", "gaming",
  "wireless", "used", "new", "the", "pair", "set",
]);
// Distinctive model token: prefer a digit-bearing token (model numbers), else the
// last meaningful word. Split on spaces AND hyphens so "ath-r70x" yields "r70x"
// (not a fused "athr70x") and "HE-400SE"/"HE 400 SE"/"HE400SE" all match.
export function modelToken(q) {
  const words = (q || "").toLowerCase().split(/[\s-]+/).map(function (w) { return w.replace(/[^a-z0-9]/g, ""); }).filter(Boolean);
  const digits = words.filter(function (w) { return /\d/.test(w) && w.length >= 2; });
  if (digits.length) return digits[digits.length - 1];
  // No model number → prefer the last DISTINCTIVE (non-generic) word, e.g. a
  // brand. Fall back to no gate ("") rather than gating on a category noun.
  for (let i = words.length - 1; i >= 0; i--)
    if (words[i].length >= 3 && !GENERIC_WORDS.has(words[i])) return words[i];
  return "";
}
export function matchesModel(title, model) {
  if (!model) return true;
  const nt = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "6xx"-style placeholder is a wildcard: match the literal ("hd6xx") OR the
  // real numbered variants it stands in for ("hd650"/"hd600"/"hd660").
  const xx = model.match(/^(\d)xx$/);
  if (xx) return new RegExp(xx[1] + "(?:xx|\\d\\d)").test(nt);
  return nt.includes(model);
}

// ---- whole-listing gate ----------------------------------------------------
// The full "keep this listing?" decision used by the Reddit and scraper paths:
// name the model, not an accessory, and (if priced) inside the price band.
// Unpriced listings (WTB / body-priced posts) are kept — price lives elsewhere.
//   opts.model  — precomputed modelToken(query); pass it so callers compute once
//   opts.min/max — USD bounds (string or number); null/"" means unbounded
export function keepListing(title, price, opts) {
  const o = opts || {};
  if (!title) return false;
  if (!matchesModel(title, o.model)) return false;
  if (isAccessory(title)) return false;
  if (price == null) return true;
  const lo = o.min != null && String(o.min).trim() !== "" ? Number(o.min) : null;
  const hi = o.max != null && String(o.max).trim() !== "" ? Number(o.max) : null;
  if (lo != null && price < lo) return false;
  if (hi != null && price > hi) return false;
  return true;
}
