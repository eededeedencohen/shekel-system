/**
 * @file backupJson — full EJSON dump of every collection
 * @module scripts/backupJson
 *
 * mongodump-free safety net for the remodel migration: writes every
 * collection to server/backups/<timestamp>/<collection>.ejson.json in
 * canonical Extended JSON (ObjectIds and Dates survive round-trips).
 *
 * Restore one collection:
 *   const { EJSON } = require("bson");
 *   db.collection(name).insertMany(EJSON.parse(fs.readFileSync(file, "utf8")));
 *
 * Usage:  node scripts/backupJson.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const connectDB = require("../config/db");

(async () => {
  await connectDB();
  const db = mongoose.connection.db;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(__dirname, "..", "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."));

  let total = 0;
  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(
      path.join(dir, `${name}.ejson.json`),
      EJSON.stringify(docs, { relaxed: false })
    );
    console.log(`${name.padEnd(20)} ${docs.length}`);
    total += docs.length;
  }
  console.log(`\n✅ ${collections.length} collections, ${total} docs → ${dir}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
