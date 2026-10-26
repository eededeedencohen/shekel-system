/**
 * @file storedFiles - the small things every family does with a file row
 * @module services/storedFiles
 *
 * Kept apart from fileService (which knows the families) so a family
 * service can require this without a cycle: destroy a file wherever its
 * bytes are, sign a read of it, answer a legacy content route with a
 * redirect to the bucket, mark it attached.
 */

const StoredFile = require("../models/StoredFile");
const storage = require("./storage");

const MAX_THUMB_BYTES = 256 * 1024;
const keysOf = (row) => [row?.storageKey, row?.thumbKey].filter(Boolean);
const inBucket = (row) => !!row?.storageKey;
const hasThumb = (row) => !!(row?.thumbKey || (row?.thumb && row.thumb.length));

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
 * A signed read of a row's bytes (60 seconds). A legacy row (bytes in the
 * database) answers the app's own streaming route instead, so the client
 * reads every file the same way until the migration is through.
 */
async function signedRead(row, { thumb = false, download = false } = {}) {
  if (thumb && !hasThumb(row)) return null;
  if (!inBucket(row)) return { url: `/api/files/${row._id}/bytes${thumb ? "?thumb=1" : ""}`, legacy: true, expiresAt: null, mime: thumb ? "image/jpeg" : row.mime, name: row.name, size: row.size };
  const key = thumb ? row.thumbKey : row.storageKey;
  const inline = !download && !/msword|officedocument/.test(row.mime || "");
  const signed = await storage.presignGet({ key, mime: thumb ? "image/jpeg" : row.mime, name: thumb ? `${row.name || "file"}.thumb.jpg` : row.name, inline });
  return { url: signed.url, legacy: false, expiresAt: signed.expiresAt, mime: thumb ? "image/jpeg" : row.mime, name: row.name, size: thumb ? row.thumbSize : row.size };
}

/**
 * The legacy content routes (…/file, …/thumb, …/image, …/cover) call this
 * first: a file already in the bucket is answered with a 302 to a signed
 * URL (their own access check already passed). false = serve as before.
 */
async function redirectIfRemote(req, res, fileId, { thumb = false, download = false } = {}) {
  if (!fileId) return false;
  const row = await StoredFile.findById(fileId).select("storageKey thumbKey thumbSize name mime size").lean();
  if (!row || !inBucket(row)) return false;
  if (thumb && !row.thumbKey) return false;
  const signed = await signedRead(row, { thumb, download });
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

module.exports = { MAX_THUMB_BYTES, keysOf, inBucket, hasThumb, destroy, destroyMany, signedRead, redirectIfRemote, markAttached };
