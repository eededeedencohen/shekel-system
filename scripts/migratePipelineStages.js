/**
 * @file migratePipelineStages — the 2026-09-17 pipeline spec on stored data
 * @module scripts/migratePipelineStages
 *
 * Eden's מכללה לכל pipeline folded the 2026-09-09 diagram's three
 * social-worker stops (ReservedSeat → Intake → AwaitingDocuments) into ONE
 * stage, "Intake" (קליטה אצל העובדת סוציאלית), whose sub-state lives on the
 * `intakes` record as three tags. This script rewrites what is stored:
 *
 *   profiles   pipeline.stage and every stageHistory[].stage of a retired
 *              key → its LEGACY_STAGE_MAP target (notes stay, so the story
 *              of the old stops is still readable on the student page)
 *   intakes    document rows of the retired checklist (idCopy, eligibility,
 *              medical, registrationForm, guardianship) are dropped; the
 *              rows of the new keys are created on the next write
 *
 * Writes go through the native driver on purpose: the Profile model blocks
 * query updates of pipeline/stageHistory (moveToStage() is the only legal
 * writer for the app) — a data migration is the one place that may bypass
 * it. Idempotent; run it as many times as you like:
 *
 *   cd server && node scripts/migratePipelineStages.js            # every world
 *   cd server && node scripts/migratePipelineStages.js --world=test
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { LEGACY_STAGE_MAP, INTAKE_DOCUMENT_KEYS, WORLDS } = require("../utils/domain");

const worldArg = process.argv.find((a) => a.startsWith("--world="))?.slice(8);
if (worldArg && !WORLDS.includes(worldArg)) {
  console.error(`world לא מוכר: ${worldArg} (${WORLDS.join(" | ")})`);
  process.exit(1);
}
const scope = worldArg ? { world: worldArg } : {};
const legacy = Object.keys(LEGACY_STAGE_MAP);

(async () => {
  const DB = process.env.DATABASE.replace("<PASSWORD>", process.env.DATABASE_PASSWORD);
  await mongoose.connect(DB);
  const db = mongoose.connection.db;
  const profiles = db.collection("profiles");
  const intakes = db.collection("intakes");

  let heads = 0;
  let entries = 0;
  for (const [from, to] of Object.entries(LEGACY_STAGE_MAP)) {
    const r1 = await profiles.updateMany({ ...scope, "pipeline.stage": from }, { $set: { "pipeline.stage": to } });
    heads += r1.modifiedCount;
    const r2 = await profiles.updateMany(
      { ...scope, "stageHistory.stage": from },
      { $set: { "stageHistory.$[h].stage": to } },
      { arrayFilters: [{ "h.stage": from }] }
    );
    entries += r2.modifiedCount;
  }
  const r3 = await intakes.updateMany(
    { ...scope, "documents.key": { $nin: INTAKE_DOCUMENT_KEYS } },
    { $pull: { documents: { key: { $nin: INTAKE_DOCUMENT_KEYS } } } }
  );

  const left = await profiles.countDocuments({ ...scope, $or: [{ "pipeline.stage": { $in: legacy } }, { "stageHistory.stage": { $in: legacy } }] });
  console.log(
    `${worldArg || "every world"}: ${heads} current stages + ${entries} profiles' history rewritten (${legacy.join(", ")} → ${[...new Set(Object.values(LEGACY_STAGE_MAP))].join(", ")}); ` +
      `${r3.modifiedCount} intake files trimmed to the new checklist; ${left} legacy stages left`
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
