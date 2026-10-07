/**
 * @file migrateShkedia — "אישור שקדייה" the document → "נקלט/ה בשקדיה" the action
 * @module scripts/migrateShkedia
 *
 * The social worker (2026-10-07): there is no approval that arrives from
 * outside; the coordinator enters the person in שקדיה herself. Every
 * record that still carries the old `shkedia` document row is rewritten:
 *   received (with or without a date)  → intake.shkedia = { enteredAt: receivedAt, by: receivedBy }
 *   waived                             → the same (the office said it was handled)
 *   uploaded / missing / rejected      → nothing — the coordinator will mark it
 * The row itself is dropped (the model prunes retired keys on save), the
 * stored file of an uploaded approval is deleted, and the status is
 * recomputed. Idempotent: a record without the row is left alone.
 *
 * Usage:  node scripts/migrateShkedia.js [--dry]
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Intake = require("../models/Intake");
const StoredFile = require("../models/StoredFile");
const intakeService = require("../services/intakeService");

const DRY = process.argv.includes("--dry");

(async () => {
  await connectDB();
  const records = await Intake.find({ "documents.key": "shkedia" });
  let moved = 0;
  let dropped = 0;
  for (const rec of records) {
    const row = rec.documents.find((d) => d.key === "shkedia");
    if (row && ["received", "waived"].includes(row.status) && !rec.shkedia?.enteredAt) {
      rec.shkedia = { enteredAt: row.receivedAt || rec.updatedAt || new Date(), by: row.receivedBy, note: "הועבר מ'אישור שקדייה' (מיגרציה 2026-10-07)" };
      rec.log.push({ action: "shkedia", by: "מיגרציה", note: `נקלט/ה בשקדיה · הועבר מהאישור הישן${row.validUntil ? ` (היה בתוקף עד ${new Date(row.validUntil).toLocaleDateString("he-IL")})` : ""}` });
      moved++;
    }
    if (row?.file?.stored && !DRY) await StoredFile.deleteOne({ _id: row.file.stored });
    if (row?.file?.storedName) {
      const p = intakeService.documentPath(rec, row);
      if (p && !DRY) {
        try {
          require("fs").unlinkSync(p);
        } catch {
          /* already gone */
        }
      }
    }
    rec.documents = rec.documents.filter((d) => d.key !== "shkedia");
    rec.status = intakeService.computeStatus(rec);
    dropped++;
    console.log(`${DRY ? "[dry] " : ""}${rec.world} · ${rec._id} · ${row?.status} → ${rec.shkedia?.enteredAt ? "נקלט/ה בשקדיה" : "ללא קליטה"} · status ${rec.status}`);
    if (!DRY) await rec.save();
  }
  console.log(`\n${DRY ? "would rewrite" : "rewrote"} ${dropped} records (${moved} marked as entered in שקדיה)`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
