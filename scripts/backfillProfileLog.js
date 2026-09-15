/**
 * @file Backfill: profile lifecycle (since / log) for pre-existing profiles
 * @module scripts/backfillProfileLog
 *
 * Profiles created before the program-lifecycle log existed have no
 * `since` and an empty `log`. This stamps each one with a single `opened`
 * entry at its createdAt (the migration copied the person's original
 * createdAt, so this IS the day the role began) — additive only, never
 * touches a profile that already has a log.
 *
 * Usage:
 *   node scripts/backfillProfileLog.js --dry
 *   node scripts/backfillProfileLog.js --world=real
 *   node scripts/backfillProfileLog.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const DRY = process.argv.includes("--dry");
const worldArg = (process.argv.find((a) => a.startsWith("--world=")) || "").split("=")[1];

async function main() {
  await connectDB();
  const profiles = mongoose.connection.db.collection("profiles");
  const filter = { $or: [{ log: { $exists: false } }, { log: { $size: 0 } }] };
  if (worldArg) filter.world = worldArg;

  const todo = await profiles.find(filter).project({ _id: 1, world: 1, kind: 1, active: 1, createdAt: 1, updatedAt: 1 }).toArray();
  const byWorld = {};
  for (const p of todo) byWorld[p.world] = (byWorld[p.world] || 0) + 1;
  console.log(`profiles without a lifecycle log: ${todo.length}`, byWorld);
  if (DRY) {
    console.log("dry run — nothing written.");
  } else {
    let n = 0;
    for (const p of todo) {
      const at = p.createdAt || new Date();
      const set = { since: at, log: [{ event: "opened", at, by: "מערכת", note: "אתחול יומן התוכניות" }] };
      if (p.active === false) {
        set.until = p.updatedAt || at;
        set.log.push({ event: "closed", at: set.until, by: "מערכת", note: "נסגר לפני שהיומן קיים" });
      }
      await profiles.updateOne({ _id: p._id }, { $set: set });
      n++;
    }
    console.log(`stamped ${n} profiles.`);
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
