/**
 * @file importCultureSenzey - put the real תרבות לכל history (senzey, תשפ"ו)
 *       into the app. See scripts/lib/senzeyCulture.js for what and how.
 *
 * Usage:
 *   node scripts/importCultureSenzey.js                         real people
 *   node scripts/importCultureSenzey.js --people=fake           pseudonymous stand-ins
 *   node scripts/importCultureSenzey.js --dry                   report only
 *   node scripts/importCultureSenzey.js --reset                 re-import the events
 *   node scripts/importCultureSenzey.js --no-interest           without the interest list
 *
 * Idempotent - run it again and it reports "existing" everywhere.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { importCultureSenzey, formatReport } = require("./lib/senzeyCulture");

const args = process.argv.slice(2);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const people = opt("people") || "real";
if (!["real", "fake"].includes(people)) {
  console.error("--people must be real or fake");
  process.exit(1);
}

(async () => {
  await connectDB();
  const t0 = Date.now();
  const report = await importCultureSenzey({
    people,
    dry: args.includes("--dry"),
    reset: args.includes("--reset"),
    interest: !args.includes("--no-interest"),
  });
  console.log(formatReport(report));
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
