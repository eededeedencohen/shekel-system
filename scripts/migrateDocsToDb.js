/**
 * @file migrateDocsToDb - intake documents from the server's disk into the `files` table
 * @module scripts/migrateDocsToDb
 *
 * Until 2026-10-07 every intake document was a file under
 * UPLOAD_DIR/<world>/<intakeId>/ - and Render wipes that disk on every
 * deploy (flagged to Eden 2026-09-22). This copies every file that still
 * exists on the disk into StoredFile (`files`), points the document row
 * at it (`file.stored`) and clears `file.storedName`. A row whose disk
 * file is already gone is reported and left as it is (the staff will ask
 * for the document again). Idempotent.
 *
 * Usage:  node scripts/migrateDocsToDb.js [--dry] [--delete]   (--delete removes the disk copy after a successful copy)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Intake = require("../models/Intake");
const StoredFile = require("../models/StoredFile");
const intakeService = require("../services/intakeService");

const DRY = process.argv.includes("--dry");
const DELETE = process.argv.includes("--delete");

(async () => {
  await connectDB();
  const records = await Intake.find({ "documents.file.storedName": { $exists: true, $ne: null } });
  let copied = 0;
  let missing = 0;
  for (const rec of records) {
    let touched = false;
    for (const row of rec.documents) {
      if (!row.file?.storedName) continue;
      const p = intakeService.documentPath(rec, row);
      if (!p || !fs.existsSync(p)) {
        missing++;
        console.log(`✗ ${rec.world} · ${rec._id} · ${row.key} · the file is gone from the disk (${row.file.storedName})`);
        continue;
      }
      const data = fs.readFileSync(p);
      if (!DRY) {
        const stored = await StoredFile.create({ world: rec.world, name: row.file.name || row.file.storedName, mime: row.file.mime, size: data.length, data });
        row.file.stored = stored._id;
        row.file.storedName = undefined;
        touched = true;
        if (DELETE) fs.unlinkSync(p);
      }
      copied++;
      console.log(`✓ ${rec.world} · ${rec._id} · ${row.key} · ${data.length} bytes${DRY ? " (dry)" : ""}`);
    }
    if (touched) {
      rec.markModified("documents");
      await rec.save();
    }
  }
  console.log(`\n${DRY ? "would copy" : "copied"} ${copied} files · ${missing} rows whose disk file is gone`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
