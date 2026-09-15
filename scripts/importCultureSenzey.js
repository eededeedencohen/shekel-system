/**
 * @file importCultureSenzey — put the real תרבות לכל history (senzey, תשפ"ו)
 *       into a world. See scripts/lib/senzeyCulture.js for what and how.
 *
 * Usage:
 *   node scripts/importCultureSenzey.js --world=real            real people
 *   node scripts/importCultureSenzey.js --world=test            fake stand-ins
 *   node scripts/importCultureSenzey.js --world=real --dry      report only
 *   node scripts/importCultureSenzey.js --world=test --reset    re-import the events
 *   node scripts/importCultureSenzey.js --world=real --no-interest   without the interest list
 *
 * Idempotent — run it again and it reports "existing" everywhere.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { WORLDS } = require("../utils/domain");
const { importCultureSenzey, formatReport } = require("./lib/senzeyCulture");

const args = process.argv.slice(2);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const world = opt("world");
if (!WORLDS.includes(world)) {
  console.error(`--world must be one of ${WORLDS.join(", ")}`);
  process.exit(1);
}
const people = opt("people") || (world === "real" ? "real" : "fake");
if (world !== "real" && people === "real") {
  console.error("real people go into the real world only — the demo worlds stay fake");
  process.exit(1);
}

(async () => {
  await connectDB();
  const t0 = Date.now();
  const report = await importCultureSenzey({
    world,
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
