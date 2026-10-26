/**
 * @file In-memory storage driver - the tests' S3
 * @module services/storage/memoryStorage
 *
 * The same contract as s3Storage, over a Map, so no test touches the
 * network. A "presigned" PUT is a `memory://put/<key>` address; a test
 * plays the browser by calling `putBuffer` (or `uploadTo(url, body)`),
 * and `head` / `tags` show what the server would see.
 */

const store = new Map(); // key → { body: Buffer, mime, tags: Set<string> }

const PUT_SECONDS = 5 * 60;
const GET_SECONDS = 60;
const inSeconds = (s) => new Date(Date.now() + s * 1000);

async function presignPut({ key, mime, pending = true }) {
  return { url: `memory://put/${key}`, method: "PUT", headers: { "Content-Type": mime, ...(pending && { "x-amz-tagging": "status=pending" }) }, expiresAt: inSeconds(PUT_SECONDS) };
}

async function presignGet({ key, mime, name, inline = true, expiresIn = GET_SECONDS }) {
  const q = new URLSearchParams({ name: name || "", inline: inline ? "1" : "0", mime: mime || "" });
  return { url: `memory://get/${key}?${q}`, expiresAt: inSeconds(expiresIn) };
}

async function head(key) {
  const o = store.get(key);
  return o ? { size: o.body.length, mime: o.mime } : null;
}

async function remove(key) {
  store.delete(key);
}

async function removeMany(keys) {
  for (const k of keys || []) store.delete(k);
}

async function clearPending(key) {
  const o = store.get(key);
  if (o) o.tags.clear();
}

async function putBuffer({ key, body, mime, pending = false }) {
  store.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), mime, tags: new Set(pending ? ["status=pending"] : []) });
}

async function getBuffer(key) {
  const o = store.get(key);
  if (!o) throw new Error(`memoryStorage: no object ${key}`);
  return o.body;
}

/* ── the tests' side of the browser ── */

/** "Upload" to a presigned PUT exactly as the browser would (the headers decide the type and the tag). */
async function uploadTo(put, body) {
  const key = String(put.url).replace(/^memory:\/\/put\//, "");
  await putBuffer({ key, body, mime: put.headers["Content-Type"], pending: put.headers["x-amz-tagging"] === "status=pending" });
}

const tags = (key) => [...(store.get(key)?.tags || [])];
const has = (key) => store.has(key);
const reset = () => store.clear();

module.exports = { driver: "memory", PUT_SECONDS, GET_SECONDS, presignPut, presignGet, head, remove, removeMany, clearPending, putBuffer, getBuffer, uploadTo, tags, has, reset };
