/**
 * @file Migration: profiles → tags (personTags, personTagEvents, cycleTags)
 * @module scripts/migrateTags
 *
 * Additive and idempotent (services/tagMigration): fills the tag tables
 * from the old profiles and cycles, touching nothing old. Safe to re-run.
 *
 * Usage:
 *   node scripts/migrateTags.js --dry
 *   node scripts/migrateTags.js --world=test
 *   node scripts/migrateTags.js            (every world)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { WORLDS } = require("../utils/domain");
const { migrateWorld } = require("../services/tagMigration");

const DRY = process.argv.includes("--dry");
const worldArg = (process.argv.find((a) => a.startsWith("--world=")) || "").split("=")[1];

async function main() {
  await connectDB();
  const worlds = worldArg ? [worldArg] : WORLDS;
  for (const world of worlds) await migrateWorld(world, { dry: DRY, log: console.log });
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
