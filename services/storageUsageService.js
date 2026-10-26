/**
 * @file storageUsageService - how full the two stores are
 * @module services/storageUsageService
 *
 * Eden (2026-10-26): "לראות את מכסת הזיכרון גם במונגו וגם בחדש של הקבצים…
 * כדי שאדע מתי כדאי לעשות אותם בתשלום". The database from `db.stats()` and
 * `$collStats` per collection against Atlas M0's 512MB; the bucket from
 * the `files` rows themselves (sizes the server verified at confirm - no
 * ListBucket permission needed; older versions in the recycle bin and the
 * waiver signatures - a few KB each - are not counted). Since stage 3 of
 * the S3 move (2026-10-26) no file bytes sit in the database at all.
 * Cached ten minutes.
 */

const mongoose = require("mongoose");
const StoredFile = require("../models/StoredFile");

const ATLAS_M0_BYTES = 512 * 1024 * 1024;
const S3_FREE_TIER_BYTES = 5 * 1024 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };

const sum = (rows, field) => rows.reduce((n, r) => n + (r[field] || 0), 0);

/** The collections this app owns (every registered model's); the Atlas database is shared with other projects, whose collections count against the same quota. */
const appCollections = () => new Set(mongoose.modelNames().map((n) => mongoose.model(n).collection.name));

async function collectionStats(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const mine = appCollections();
  const out = [];
  for (const name of names) {
    try {
      const [s] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const st = s?.storageStats || {};
      out.push({ name, app: mine.has(name), count: st.count || 0, dataSize: st.size || 0, storageSize: st.storageSize || 0, indexSize: st.totalIndexSize || 0 });
    } catch {
      /* a view or a collection that refuses stats - skipped */
    }
  }
  return out.sort((a, b) => b.dataSize + b.indexSize - (a.dataSize + a.indexSize));
}

async function usage({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const db = mongoose.connection.db;
  const stats = await db.stats();
  const collections = await collectionStats(db);
  const bucketRows = await StoredFile.aggregate([
    { $match: { storageKey: { $exists: true, $ne: null } } },
    { $group: { _id: "$family", files: { $sum: 1 }, bytes: { $sum: { $ifNull: ["$size", 0] } }, thumbBytes: { $sum: { $ifNull: ["$thumbSize", 0] } }, pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } } } },
  ]);
  const byFamily = (rows) => rows.map((r) => ({ family: r._id || "other", files: r.files, bytes: r.bytes + (r.thumbBytes || 0), pending: r.pending || 0 })).sort((a, b) => b.bytes - a.bytes);
  const value = {
    at: new Date(),
    mongo: {
      limitBytes: ATLAS_M0_BYTES,
      // Atlas counts the logical data + indexes against the tier's quota
      usedBytes: (stats.dataSize || 0) + (stats.indexSize || 0),
      dataSize: stats.dataSize || 0,
      indexSize: stats.indexSize || 0,
      storageSize: stats.storageSize || 0,
      // what other projects on the same Atlas database take of the quota
      othersBytes: collections.filter((c) => !c.app).reduce((n, c) => n + c.dataSize + c.indexSize, 0),
      collections,
    },
    bucket: {
      name: process.env.AWS_S3_BUCKET_NAME || null,
      region: process.env.AWS_REGION || null,
      freeTierBytes: S3_FREE_TIER_BYTES,
      usedBytes: sum(bucketRows, "bytes") + sum(bucketRows, "thumbBytes"),
      files: sum(bucketRows, "files"),
      pending: sum(bucketRows, "pending"),
      byFamily: byFamily(bucketRows),
    },
  };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { usage, ATLAS_M0_BYTES, S3_FREE_TIER_BYTES };
