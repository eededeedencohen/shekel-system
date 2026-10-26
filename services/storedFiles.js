/**
 * @file storedFiles - the small things every family does with a file row
 * @module services/storedFiles
 *
 * Kept apart from fileService (which knows the families) so a family
 * service can require this without a cycle: destroy a file and its
 * objects, sign a read of it, answer a plain content route with a
 * redirect to the bucket, mark it attached, put bytes the server holds.
 * Since stage 3 of the S3 move (2026-10-26) the bucket is the ONLY place
 * bytes live - the database holds facts.
 */

const { randomUUID } = require("crypto");
const StoredFile = require("../models/StoredFile");
const storage = require("./storage");

const MAX_THUMB_BYTES = 256 * 1024;
const keysOf = (row) => [row?.storageKey, row?.thumbKey].filter(Boolean);
const inBucket = (row) => !!row?.storageKey;
const hasThumb = (row) => !!row?.thumbKey;

/** The row and its bytes, wherever they are. A missing row is nothing to do. */
async function destroy(fileId, { session = null } = {}) {
  if (!fileId) return;
  const row = await StoredFile.findById(fileId).select("storageKey thumbKey").lean();
  if (!row) return;
  await StoredFile.deleteOne({ _id: row._id }, session ? { session } : {});
  const keys = keysOf(row);
  if (keys.length) await storage.removeMany(keys).catch(() => {});
}

async function destroyMany(fileIds) {
  const ids = (fileIds || []).filter(Boolean);
  if (!ids.length) return;
  const rows = await StoredFile.find({ _id: { $in: ids } }).select("storageKey thumbKey").lean();
  await StoredFile.deleteMany({ _id: { $in: ids } });
  const keys = rows.flatMap(keysOf);
  if (keys.length) await storage.removeMany(keys).catch(() => {});
}

/**
 * A signed read of a row's bytes (60 seconds). null when there is nothing
 * to read: no thumbnail was asked for and none exists, or the row never
 * reached the bucket (a pending upload the browser abandoned).
 */
async function signedRead(row, { thumb = false, download = false } = {}) {
  if (!inBucket(row)) return null;
  if (thumb && !hasThumb(row)) return null;
  const key = thumb ? row.thumbKey : row.storageKey;
  const inline = !download && !/msword|officedocument/.test(row.mime || "");
  const signed = await storage.presignGet({ key, mime: thumb ? "image/jpeg" : row.mime, name: thumb ? `${row.name || "file"}.thumb.jpg` : row.name, inline });
  return { url: signed.url, expiresAt: signed.expiresAt, mime: thumb ? "image/jpeg" : row.mime, name: row.name, size: thumb ? row.thumbSize : row.size };
}

/**
 * The plain content routes (…/file, …/thumb, …/image, …/cover - an <a href>,
 * an old link) call this once their own access check passed: the file is
 * answered with a 302 to a signed URL. false = nothing to send (the route
 * answers 404).
 */
async function redirectIfRemote(req, res, fileId, { thumb = false, download = false } = {}) {
  if (!fileId) return false;
  const row = await StoredFile.findById(fileId).select("storageKey thumbKey thumbSize name mime size").lean();
  const signed = row && (await signedRead(row, { thumb, download }));
  if (!signed) return false;
  res.set("Cache-Control", "private, no-store");
  res.redirect(302, signed.url);
  return true;
}

/** The file is now hanging on its record: remembered, and the bucket's pending tag goes. */
async function markAttached(row) {
  if (!row) return;
  row.attachedAt = new Date();
  await row.save();
  for (const key of keysOf(row)) await storage.clearPending(key).catch(() => {});
}

/**
 * Bytes the SERVER holds (a base64 upload from an old tab or a test, a
 * picture fetched from the web, a cover the lookup found) → an object in
 * the bucket and a ready, attached row. Small files only - the browser
 * uploads the big ones itself (fileService).
 */
async function createFromBuffer({ family, owner = {}, name, mime, buffer, thumb = null, uploadedBy = {} }) {
  const storageKey = `${family}/${owner.id || "new"}/${randomUUID()}`;
  await storage.putBuffer({ key: storageKey, body: buffer, mime });
  let thumbKey;
  if (thumb && thumb.length && thumb.length <= MAX_THUMB_BYTES) {
    thumbKey = `${storageKey}.thumb.jpg`;
    await storage.putBuffer({ key: thumbKey, body: thumb, mime: "image/jpeg" }).catch(() => {
      thumbKey = undefined;
    });
  }
  try {
    return await StoredFile.create({ name, mime, size: buffer.length, status: "ready", storageKey, thumbKey, thumbSize: thumbKey ? thumb.length : undefined, family, owner, attachedAt: new Date(), uploadedBy });
  } catch (e) {
    await storage.removeMany([storageKey, thumbKey].filter(Boolean)).catch(() => {});
    throw e;
  }
}

module.exports = { MAX_THUMB_BYTES, keysOf, inBucket, hasThumb, destroy, destroyMany, signedRead, redirectIfRemote, markAttached, createFromBuffer };
