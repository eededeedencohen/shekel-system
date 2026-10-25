/**
 * @file Migration: profiles → tags (personTags, personTagEvents, cycleTags)
 * @module scripts/migrateTags
 *
 * Additive and idempotent (services/tagMigration): fills the tag tables
 * from the old profiles and cycles, touching nothing old. Safe to re-run.
 *
 * Usage:
 *   node scripts/migrateTags.js --dry
 *   node scripts/migrateTags.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { migrateTags } = require("../services/tagMigration");

const DRY = process.argv.includes("--dry");

async function main() {
  await connectDB();
  await migrateTags({ dry: DRY, log: console.log });
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
