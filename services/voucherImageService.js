/**
 * @file The picture of a voucher's place, found on the web
 * @module services/voucherImageService
 *
 * Eden (2026-10-13): "לחפש בוואב תמונות של המקום הרלוונטי לשובר". Without a
 * paid image-search key the app asks Wikipedia (Hebrew first, English
 * behind it): its search API hands back the page image of every matching
 * article - a chain's logo, a venue's photo - free to use and keyless. A
 * link pasted by the staff is accepted too: a picture's own address, or
 * a page whose `og:image` is the picture (like the library's book lookup).
 *
 * Dependency-free: Node's `fetch`, a few regexes. Tests swap the network
 * with `setFetch()`.
 */

const HEADERS = {
  "User-Agent": "shekel-app/1.0 (eededeedencohen@gmail.com)",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};
const TIMEOUT_MS = 9000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const WIKI = { he: "https://he.wikipedia.org/w/api.php", en: "https://en.wikipedia.org/w/api.php" };

let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { headers: HEADERS, redirect: "follow", signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const isHttp = (u) => /^https?:\/\//i.test(String(u || ""));

/** The article images matching a name on one Wikipedia, best match first. */
async function searchOn(lang, q, limit) {
  const url =
    `${WIKI[lang]}?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(q)}` +
    `&gsrlimit=${limit}&prop=pageimages|info&piprop=thumbnail|original&pithumbsize=640&inprop=url`;
  const r = await get(url);
  if (!r.ok) return [];
  const j = await r.json();
  return Object.values(j?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .filter((p) => p.thumbnail?.source)
    .map((p) => ({
      title: p.title,
      url: p.thumbnail.source,
      width: p.thumbnail.width,
      height: p.thumbnail.height,
      page: p.fullurl || null,
      source: lang === "he" ? "ויקיפדיה" : "Wikipedia",
    }));
}

/**
 * Pictures for a place name: Hebrew Wikipedia, then English when Hebrew
 * knows fewer than three. Never throws - no network means no pictures.
 */
async function searchImages(q, limit = 8) {
  const name = String(q || "").trim();
  if (name.length < 2) return [];
  try {
    const he = await searchOn("he", name, limit);
    if (he.length >= 3) return he;
    const en = await searchOn("en", name, limit).catch(() => []);
    const seen = new Set(he.map((x) => x.url));
    return [...he, ...en.filter((x) => !seen.has(x.url))].slice(0, limit);
  } catch {
    return [];
  }
}

/** `og:image` of a page (either attribute order), made absolute. */
function ogImageOf(html, pageUrl) {
  const m =
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i.exec(html);
  if (!m) return null;
  try {
    return new URL(m[1].replace(/&amp;/g, "&"), pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * The picture at a link: the bytes when the link is a picture, else the
 * page's og:image. `{ mime, buffer, from }` or null.
 */
async function fetchImage(link) {
  if (!isHttp(link)) return null;
  const r = await get(link);
  if (!r.ok) return null;
  const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) {
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    return { mime, buffer, from: link };
  }
  if (!mime.includes("html")) return null;
  const og = ogImageOf(await r.text(), link);
  if (!og || og === link) return null;
  const r2 = await get(og);
  if (!r2.ok) return null;
  const mime2 = (r2.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mime2.startsWith("image/")) return null;
  const buffer = Buffer.from(await r2.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  return { mime: mime2, buffer, from: og };
}

module.exports = { searchImages, fetchImage, ogImageOf, setFetch, MAX_IMAGE_BYTES };
