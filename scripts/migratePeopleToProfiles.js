/**
 * @file Migration: people (role discriminators) → people + profiles
 * @module scripts/migratePeopleToProfiles
 *
 * Phase 2 of people-remodel-plan.html. For every person that still carries
 * the old `role` field, creates the matching profile document and finally
 * $unsets the role-shaped fields off `people`. Identity (_id!) is never
 * touched — enrollments / lessons / cycles are not mentioned here at all.
 *
 * Idempotent: an existing {person, kind} profile is skipped, so re-running
 * after a partial failure is safe.
 *
 * Usage:
 *   node scripts/migratePeopleToProfiles.js --dry            # report only
 *   node scripts/migratePeopleToProfiles.js --world=test     # one world
 *   node scripts/migratePeopleToProfiles.js                  # all worlds
 *   node scripts/migratePeopleToProfiles.js --cleanup        # also $unset
 *
 * Run order: test → pokemon → real; run --cleanup only after the counts
 * printed by the verify step match. Take a mongodump first.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");

const DRY = process.argv.includes("--dry");
const CLEANUP = process.argv.includes("--cleanup");
const worldArg = (process.argv.find((a) => a.startsWith("--world=")) || "").split("=")[1];

/** Old role → profile kind + the fields that move with it. */
const ROLE_MAP = {
  Student: {
    kind: "StudentCollege",
    fields: [
      "pipeline", "stageHistory", "matching", "residence", "address", "city",
      "notes", "emergencyContact", "emergencyPhone", "caseCoordinator", "import",
    ],
  },
  Teacher: { kind: "Teacher", fields: ["subjects", "import"] },
  Admin: { kind: "Admin", fields: [] },
};

/** Every legacy path that must leave `people` at cleanup. */
const LEGACY_PATHS = [
  "role", "pipeline", "stageHistory", "matching", "residence", "address",
  "city", "notes", "emergencyContact", "emergencyPhone", "caseCoordinator",
  "import", "subjects",
];

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  const people = db.collection("people");

  const filter = { role: { $exists: true } };
  if (worldArg) filter.world = worldArg;

  const byRoleWorld = await people
    .aggregate([{ $match: filter }, { $group: { _id: { role: "$role", world: "$world" }, n: { $sum: 1 } } }])
    .toArray();
  console.log("== people still carrying a role field ==");
  for (const r of byRoleWorld) console.log(`  ${r._id.world} / ${r._id.role}: ${r.n}`);
  if (!byRoleWorld.length) console.log("  (none — nothing to migrate)");

  let created = 0, skipped = 0, unknown = 0;
  const cursor = people.find(filter);
  for await (const doc of cursor) {
    const map = ROLE_MAP[doc.role];
    if (!map) { unknown++; console.warn(`  ? unknown role "${doc.role}" — ${doc._id}`); continue; }

    const exists = await Profile.exists({ person: doc._id, kind: map.kind });
    if (exists) { skipped++; continue; }

    if (DRY) { created++; continue; }
    const Model = MODEL_BY_KIND[map.kind];
    const payload = { person: doc._id, world: doc.world };
    for (const f of map.fields) if (doc[f] !== undefined) payload[f] = doc[f];
    // bypass the moveToStage-only guard: this IS the historical data
    await Model.collection.insertOne({
      ...payload,
      kind: map.kind,
      active: true,
      createdAt: doc.createdAt || new Date(),
      updatedAt: new Date(),
    });
    created++;
  }
  console.log(`\nprofiles ${DRY ? "to create" : "created"}: ${created} · skipped (already exist): ${skipped} · unknown roles: ${unknown}`);

  // verify: every role-carrying person now has the matching profile
  const verify = await people
    .aggregate([
      { $match: filter },
      { $lookup: { from: "profiles", localField: "_id", foreignField: "person", as: "p" } },
      { $match: { p: { $size: 0 } } },
      { $count: "missing" },
    ])
    .toArray();
  const missing = verify[0]?.missing || 0;
  console.log(`verify — people with a role but NO profile: ${missing}${DRY ? " (dry run: expected > 0)" : ""}`);

  if (CLEANUP) {
    if (DRY) console.log("cleanup requested with --dry — skipping.");
    else if (missing > 0) console.log("cleanup REFUSED — migrate the missing people first.");
    else {
      const unset = Object.fromEntries(LEGACY_PATHS.map((p) => [p, ""]));
      const r = await people.updateMany(worldArg ? { world: worldArg } : {}, { $unset: unset });
      console.log(`cleanup — $unset legacy fields on ${r.modifiedCount} people.`);
      try {
        await people.dropIndex("world_1_role_1");
        console.log("dropped index world_1_role_1");
      } catch { /* index may not exist */ }
    }
  } else {
    console.log("run again with --cleanup (after verifying) to $unset the legacy fields.");
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
