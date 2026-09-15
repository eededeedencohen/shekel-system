/**
 * @file Book lookup — a barcode in, the book's details (and cover) out
 * @module services/bookLookupService
 *
 * The port of Eden's `booknet_book_downloader.ipynb` (2026-09):
 *
 *   1. search צומת ספרים:  GET https://www.booknet.co.il/חיפוש?q=<barcode>
 *      → the product link is the <a href> that carries the barcode AND
 *        "מוצרים" (the URL has the title's slug, so it can't be built).
 *   2. product page: title in <h1>, author in div.pp-authors, the summary
 *      is the element after the "תקציר" heading, cover from og:image
 *      (fallback: /Images/Site/Products/<barcode>.jpg).
 *   3. download the cover (checked to be an image).
 *
 * Plus a second source the notebook did not have — Google Books by ISBN —
 * for the books booknet doesn't list. No HTML library: the two pages are
 * regular enough for a handful of regexes, and this keeps the server
 * dependency-free. `fetch` is Node's own (v18+); tests swap it via
 * `setFetch()` so nothing touches the network.
 */

const BOOKNET = "https://www.booknet.co.il";
const GOOGLE_BOOKS = "https://www.googleapis.com/books/v1/volumes";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};
const TIMEOUT_MS = 9000;
const MAX_COVER_BYTES = 3 * 1024 * 1024;

let fetchImpl = (...args) => globalThis.fetch(...args);
/** Tests (and offline seeds) replace the network here. */
function setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

/* ───────────────────────── text helpers ───────────────────────── */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—" };

/** Decode the HTML entities a shop page actually uses. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Tags → spaces, entities decoded, whitespace collapsed (bs4's get_text(" ") + _clean). */
function textOf(html) {
  return decodeEntities(String(html || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * "36200054208", "978-965-566-001-2", " 9789655660012 " → digits only
 * (an old ISBN-10 may end with X). null when it cannot be a barcode.
 */
function normalizeBarcode(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (s.length < 6 || s.length > 20) return null;
  if (!/^\d+X?$/.test(s)) return null;
  return s;
}

/* ───────────────────────── booknet parsing ───────────────────────── */

/** The product page URL out of the search results, or null. */
function parseBooknetSearch(html, barcode) {
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const decoded = safeDecode(href);
    if (decoded.includes(barcode) && decoded.includes("מוצרים")) {
      try {
        return new URL(decodeEntities(href), BOOKNET).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The text of the element that follows position `from` — the first tag
 * after it, matched to its closing tag by depth (the summary is a <div>
 * with children). Falls back to the text up to the next heading.
 */
function nextElementText(html, from) {
  const open = /<([a-z][a-z0-9]*)\b[^>]*>/i;
  const rest = html.slice(from);
  const m = open.exec(rest);
  if (!m) return "";
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(rest))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return textOf(rest.slice(start, t.index));
  }
  const nextHeading = rest.search(/<h[1-6]\b/i);
  return textOf(rest.slice(start, nextHeading > 0 ? nextHeading : undefined));
}

/** The inner text of the first element carrying `className` (depth-matched). */
function elementTextByClass(html, className) {
  const re = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*class\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(html))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return textOf(html.slice(start, t.index));
  }
  return textOf(html.slice(start));
}

/** title / author / summary / price / imageUrl of a booknet product page. */
function parseBooknetProduct(html, barcode) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const author = elementTextByClass(html, "pp-authors");

  let summary = null;
  const heading = /<h([23])\b[^>]*>(?:\s|<[^>]+>)*תקציר(?:\s|<[^>]+>)*<\/h\1>/i.exec(html);
  if (heading) summary = nextElementText(html, heading.index + heading[0].length) || null;

  let price = null;
  const p = /מחיר מכירה\s*₪?\s*(\d+(?:\.\d+)?)/.exec(textOf(html));
  if (p) price = Number(p[1]);

  const og =
    /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html) ||
    /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i.exec(html);
  let imageUrl = og ? decodeEntities(og[1]).replace("//Images", "/Images") : `${BOOKNET}/Images/Site/Products/${barcode}.jpg`;
  if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
  else if (imageUrl.startsWith("/")) imageUrl = BOOKNET + imageUrl;

  return {
    title: h1 ? textOf(h1[1]) || null : null,
    author: author || null,
    summary,
    price,
    imageUrl,
  };
}

/* ───────────────────────── network ───────────────────────── */

async function get(url, { timeout = TIMEOUT_MS, headers = HEADERS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetchImpl(url, { headers, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** booknet: { found, title, author, summary, imageUrl, productUrl } (throws on network trouble). */
async function lookupBooknet(barcode) {
  const searchUrl = `${BOOKNET}/${encodeURIComponent("חיפוש")}?q=${encodeURIComponent(barcode)}`;
  const s = await get(searchUrl);
  if (!s.ok) throw new Error(`booknet search HTTP ${s.status}`);
  const productUrl = parseBooknetSearch(await s.text(), barcode);
  if (!productUrl) return { found: false };
  const r = await get(productUrl);
  if (!r.ok) throw new Error(`booknet product HTTP ${r.status}`);
  const info = parseBooknetProduct(await r.text(), barcode);
  if (!info.title) return { found: false };
  return { found: true, source: "booknet", productUrl, ...info };
}

/** Google Books by ISBN — the fallback for titles booknet does not carry. */
async function lookupGoogle(barcode) {
  const r = await get(`${GOOGLE_BOOKS}?q=isbn:${encodeURIComponent(barcode)}&maxResults=1`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`google books HTTP ${r.status}`);
  const json = await r.json();
  const v = json?.items?.[0]?.volumeInfo;
  if (!v?.title) return { found: false };
  const thumb = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
  return {
    found: true,
    source: "google",
    title: [v.title, v.subtitle].filter(Boolean).join(" — "),
    author: (v.authors || []).join(", ") || null,
    summary: v.description || null,
    imageUrl: thumb ? thumb.replace(/^http:/, "https:").replace("&edge=curl", "") : null,
    productUrl: v.infoLink || v.canonicalVolumeLink || null,
    publisher: v.publisher || null,
    year: v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) || null : null,
    pages: v.pageCount || null,
  };
}

/** The cover bytes, or null when the URL is not an image (or too big). */
async function downloadCover(imageUrl) {
  if (!imageUrl) return null;
  const r = await get(imageUrl);
  if (!r.ok) return null;
  const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) return null;
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_COVER_BYTES) return null;
  return { mime, buffer };
}

/**
 * The main entry (the notebook's fetch_book): booknet first, Google Books
 * second, the cover downloaded when one is known.
 *
 * → { found: false, failed } when nothing was found (`failed` = every
 *   source errored, so "not found" is unknown rather than certain), or
 *   { found: true, source, title, author, summary, imageUrl, productUrl,
 *     publisher?, year?, pages?, cover: {mime, buffer} | null }
 */
async function lookupBook(rawBarcode, { withCover = true } = {}) {
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode) return { found: false, failed: false };
  let errors = 0;
  let info = null;
  for (const source of [lookupBooknet, lookupGoogle]) {
    try {
      const r = await source(barcode);
      if (r.found) {
        info = r;
        break;
      }
    } catch {
      errors++;
    }
  }
  if (!info) return { found: false, failed: errors === 2 };
  let cover = null;
  if (withCover && info.imageUrl) {
    try {
      cover = await downloadCover(info.imageUrl);
    } catch {
      cover = null;
    }
  }
  return { barcode, ...info, cover };
}

module.exports = {
  BOOKNET,
  MAX_COVER_BYTES,
  setFetch,
  normalizeBarcode,
  decodeEntities,
  textOf,
  parseBooknetSearch,
  parseBooknetProduct,
  lookupBooknet,
  lookupGoogle,
  downloadCover,
  lookupBook,
};
