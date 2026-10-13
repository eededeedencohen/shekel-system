/**
 * @file The picture of a voucher's place, found on the web
 * @module services/voucherImageService
 *
 * Eden (2026-10-13): "לחפש בוואב תמונות של המקום הרלוונטי לשובר". Without a
 * paid image-search key the app asks Wikipedia (Hebrew first, English
 * behind it): the matching articles' infobox pictures - a chain's LOGO, a
 * venue's building - then their page photos; keyless. A
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

const enc = encodeURIComponent;
async function getJson(url) {
  const r = await get(url);
  if (!r.ok) return null;
  return r.json();
}

/**
 * The picture in an article's infobox - for a chain or a venue that is its
 * LOGO (Eden, 2026-10-13: "זה לא מחפש את הלוגו" - Wikipedia's "page image"
 * leaves logos out on purpose, the infobox never does). Made absolute, the
 * tracking query dropped, asked for at 480px.
 */
function infoboxImage(html) {
  const box = /<table[^>]*class="[^"]*infobox[^"]*"[\s\S]*?<\/table>/i.exec(String(html || ""))?.[0];
  if (!box) return null;
  const img = /<img[^>]+>/i.exec(box)?.[0];
  if (!img) return null;
  // the biggest copy the page itself asks for (its 2x srcset) - Wikimedia
  // serves only the sizes a page already uses, never one made up here
  const srcset = /srcset="([^"]+)"/i.exec(img)?.[1];
  const biggest = srcset ? srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : null;
  const src = biggest || /src="([^"]+)"/i.exec(img)?.[1];
  if (!src) return null;
  let url = src.replace(/&amp;/g, "&").replace(/\?.*$/, "");
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

/**
 * The pictures of the articles matching a name on one Wikipedia: each
 * article's infobox picture (its logo) and, when different, its page image
 * (a photo). Logos first, in the order of the search.
 */
async function searchOn(lang, q, limit) {
  const api = WIKI[lang];
  const found = await getJson(`${api}?action=query&format=json&list=search&srsearch=${enc(q)}&srlimit=${limit}`);
  const titles = (found?.query?.search || []).map((x) => x.title);
  if (!titles.length) return [];
  const [pages, ...parsed] = await Promise.all([
    getJson(`${api}?action=query&format=json&prop=pageimages|info&inprop=url&piprop=thumbnail&pithumbsize=640&titles=${enc(titles.join("|"))}`).catch(() => null),
    ...titles.map((t) => getJson(`${api}?action=parse&format=json&page=${enc(t)}&prop=text&section=0&disabletoc=1`).catch(() => null)),
  ]);
  const pageOf = new Map(Object.values(pages?.query?.pages || {}).map((p) => [p.title, p]));
  const source = lang === "he" ? "ויקיפדיה" : "Wikipedia";
  const logos = [];
  const photos = [];
  titles.forEach((title, i) => {
    const page = pageOf.get(title);
    const logo = infoboxImage(parsed[i]?.parse?.text?.["*"]);
    // a placeholder ("no free image yet") or a flag from a list article is not the place
    if (logo && !/no_free_image|Flag_of_/i.test(logo)) logos.push({ title, url: logo, kind: /\.jpe?g(\.|$)/i.test(logo) ? "picture" : "logo", page: page?.fullurl || null, source });
    const photo = page?.thumbnail?.source;
    if (photo && photo !== logo) photos.push({ title, url: photo, kind: "photo", width: page.thumbnail.width, height: page.thumbnail.height, page: page?.fullurl || null, source });
  });
  return [...logos, ...photos];
}

/**
 * Pictures for a place name: Hebrew Wikipedia, then English when Hebrew
 * knows fewer than three. Never throws - no network means no pictures.
 */
async function searchImages(q, limit = 6) {
  const name = String(q || "").trim();
  if (name.length < 2) return [];
  try {
    const he = await searchOn("he", name, limit);
    if (he.length >= 3) return he.slice(0, limit * 2);
    const en = await searchOn("en", name, limit).catch(() => []);
    const seen = new Set(he.map((x) => x.url));
    return [...he, ...en.filter((x) => !seen.has(x.url))].slice(0, limit * 2);
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

module.exports = { searchImages, fetchImage, ogImageOf, infoboxImage, setFetch, MAX_IMAGE_BYTES };
