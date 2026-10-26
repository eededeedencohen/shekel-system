/**
 * @file migrateFilesToS3 - the last bytes in the database → the bucket
 * @module scripts/migrateFilesToS3
 *
 * Stage 3 of the S3 move (project-files/specs/files-s3-plan.html, Eden
 * 2026-10-26). Three kinds of bytes still sat in Mongo after stages 1-2:
 *   1. `files` rows with `data` (+ `thumb`) and no `storageKey` - the
 *      uploads from before the bucket (intake documents, a supplier's
 *      certificates, a person's papers, invoices, voucher pictures);
 *   2. book covers inline in the record (`cover.data`);
 *   3. the PNG signatures of a signed waiver (`signatures.*`).
 *
 * Every blob is first copied to the ledger folder on this machine
 * (server/backups/files-to-s3-<day>/bytes/, gitignored), then PUT to the
 * bucket, then READ BACK and compared by sha256 - only then the record is
 * pointed at the key. The ledger (ledger.json) lists what moved where.
 * The bytes stay in the database until the second pass:
 *
 *   node scripts/migrateFilesToS3.js --dry      what would move, nothing written
 *   node scripts/migrateFilesToS3.js            move (resumable - rows already in the bucket are skipped)
 *   node scripts/migrateFilesToS3.js --unset    the bytes go from the database (every key HEADed again first)
 *
 * The parent of an orphan `files` row (nothing points at it) is reported,
 * not guessed; the row is left alone. A row that still names a disk file
 * (`storedName`, the layout before 2026-10-07) with no `files` row is a
 * file the deploys wiped long ago - reported, and the dead pointer is
 * dropped by --unset. Run from this machine against the real database
 * (server/.env), never on Render.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const storage = require("../services/storage");

const DRY = process.argv.includes("--dry");
const UNSET = process.argv.includes("--unset");
const MAX_THUMB_BYTES = 256 * 1024;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** A raw-driver Buffer: bson Binary (`.buffer`), a Buffer, or nothing. */
const toBuf = (b) => (b == null ? null : Buffer.isBuffer(b) ? b : b.buffer ? Buffer.from(b.buffer) : Buffer.from(b));
const nonEmpty = (b) => (b && b.length ? b : null);

/* ── the ledger folder ── */
const backupsDir = path.join(__dirname, "..", "backups");
function ledgerDir() {
  if (UNSET) {
    const dirs = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((d) => d.startsWith("files-to-s3-")).sort() : [];
    if (!dirs.length) throw new Error("no files-to-s3-* ledger under server/backups - run the move first");
    return path.join(backupsDir, dirs[dirs.length - 1]);
  }
  const dir = path.join(backupsDir, `files-to-s3-${new Date().toISOString().slice(0, 10)}`);
  if (!DRY) fs.mkdirSync(path.join(dir, "bytes"), { recursive: true });
  return dir;
}
const dir = ledgerDir();
const ledgerPath = path.join(dir, "ledger.json");
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : [];
const saveLedger = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
const keep = (name, buf) => fs.writeFileSync(path.join(dir, "bytes", name), buf);

/** PUT, read back, compare. Throws when the bucket's copy differs. */
async function putVerified(key, body, mime) {
  await storage.putBuffer({ key, body, mime });
  const back = await storage.getBuffer(key);
  if (sha(back) !== sha(body)) throw new Error(`the bucket's copy of ${key} differs from the original`);
  return sha(body);
}

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const col = (n) => db.collection(n);
  const files = col("files");
  const report = { moved: 0, covers: 0, signatures: 0, orphans: [], lostDisk: [], skipped: 0 };
  console.log(`${DRY ? "[dry] " : ""}${UNSET ? "second pass: the bytes go from the database" : "moving the last bytes to the bucket"} · ledger ${dir}`);

  if (UNSET) {
    let unset = 0;
    for (const e of ledger) {
      for (const key of [e.storageKey, e.thumbKey, e.key].filter(Boolean)) {
        const h = await storage.head(key);
        if (!h) throw new Error(`${key} is not in the bucket - nothing is unset`);
      }
      if (e.kind === "file") await files.updateOne({ _id: new mongoose.Types.ObjectId(e.fileId) }, { $unset: { data: "", thumb: "" } });
      if (e.kind === "cover") await col("books").updateOne({ _id: new mongoose.Types.ObjectId(e.bookId) }, { $unset: { "cover.data": "", "cover.storedName": "" } });
      if (e.kind === "signature") await col("waivers").updateOne({ _id: new mongoose.Types.ObjectId(e.waiverId) }, { $unset: { [`signatures.${e.who}`]: "" } });
      unset++;
    }
    const w = await col("waivers").updateMany({ signatures: {} }, { $unset: { signatures: "" } });
    // the dead disk pointers (files the deploys wiped before 2026-10-07)
    const i = await col("intakes").updateMany({ "documents.file.storedName": { $exists: true } }, { $unset: { "documents.$[].file.storedName": "" } });
    const b = await col("books").updateMany({ "cover.storedName": { $exists: true } }, { $unset: { "cover.storedName": "" } });
    const left = await files.countDocuments({ data: { $exists: true } });
    console.log(`unset ${unset} ledger entries · ${w.modifiedCount} empty signature objects · ${i.modifiedCount} intakes / ${b.modifiedCount} books lost their disk names · files rows still carrying data: ${left}`);
    await mongoose.disconnect();
    return;
  }

  /* ── 1. files rows with bytes ── */
  const owners = [
    { c: "intakes", q: (id) => ({ "documents.file.stored": id }), of: (d, id) => ({ family: "intake", owner: { kind: "intake", id: d._id, slot: d.documents.find((r) => String(r.file?.stored) === String(id))?.key } }) },
    { c: "suppliers", q: (id) => ({ "files.file.stored": id }), of: (d, id) => ({ family: "suppliers", owner: { kind: "supplier", id: d._id, slot: d.files.find((r) => String(r.file?.stored) === String(id))?.key } }) },
    { c: "personDocuments", q: (id) => ({ file: id }), of: (d) => ({ family: "people", owner: { kind: "person", id: d.person } }) },
    { c: "invoices", q: (id) => ({ file: id }), of: (d) => ({ family: "invoices", owner: { kind: "invoice", id: d._id } }) },
    { c: "vouchers", q: (id) => ({ image: id }), of: (d) => ({ family: "culture", owner: { kind: "voucher", id: d._id } }) },
    { c: "waivers", q: (id) => ({ file: id }), of: (d) => ({ family: "intake", owner: { kind: "intake", id: d.intake, slot: "waiver" } }) },
  ];
  const rows = await files.find({ data: { $exists: true, $ne: null }, storageKey: { $exists: false } }).toArray();
  console.log(`\n1. files rows with bytes in the database: ${rows.length}`);
  for (const row of rows) {
    const data = nonEmpty(toBuf(row.data));
    if (!data) {
      console.log(`  ✗ ${row._id} · ${row.name} · empty data - skipped`);
      report.skipped++;
      continue;
    }
    let home = row.family && row.owner?.id ? { family: row.family, owner: row.owner } : null;
    for (const o of owners) {
      if (home) break;
      const parent = await col(o.c).findOne(o.q(row._id));
      if (parent) home = o.of(parent, row._id);
    }
    if (!home) {
      console.log(`  ? ${row._id} · ${row.name} · ${data.length}B · nothing points at it - left alone`);
      report.orphans.push({ fileId: String(row._id), name: row.name, size: data.length });
      continue;
    }
    const thumb = nonEmpty(toBuf(row.thumb));
    const storageKey = `${home.family}/${home.owner.id}/${crypto.randomUUID()}`;
    const thumbKey = thumb && thumb.length <= MAX_THUMB_BYTES ? `${storageKey}.thumb.jpg` : undefined;
    console.log(`  ${DRY ? "would move" : "→"} ${row._id} · ${row.name} · ${row.mime} · ${data.length}B${thumb ? ` + thumb ${thumb.length}B` : ""} · ${home.family}/${home.owner.kind} ${home.owner.id}${home.owner.slot ? `/${home.owner.slot}` : ""}`);
    if (DRY) continue;
    keep(`${row._id}.bin`, data);
    if (thumb) keep(`${row._id}.thumb.jpg`, thumb);
    const digest = await putVerified(storageKey, data, row.mime);
    const thumbDigest = thumbKey ? await putVerified(thumbKey, thumb, "image/jpeg") : null;
    await files.updateOne(
      { _id: row._id },
      { $set: { storageKey, ...(thumbKey && { thumbKey, thumbSize: thumb.length }), status: "ready", family: home.family, owner: home.owner, attachedAt: row.attachedAt || row.savedAt || row.createdAt || new Date(), size: data.length } }
    );
    ledger.push({ kind: "file", fileId: String(row._id), name: row.name, mime: row.mime, family: home.family, owner: { ...home.owner, id: String(home.owner.id) }, storageKey, size: data.length, sha256: digest, thumbKey, thumbSize: thumb?.length, thumbSha256: thumbDigest, at: new Date() });
    saveLedger();
    report.moved++;
  }

  /* ── 2. book covers inline ── */
  const books = await col("books").find({ "cover.data": { $exists: true, $ne: null }, "cover.file": { $exists: false } }).toArray();
  console.log(`\n2. books with the cover inline: ${books.length}`);
  for (const book of books) {
    const data = nonEmpty(toBuf(book.cover.data));
    const mime = book.cover.mime || "image/jpeg";
    if (!data) {
      console.log(`  ✗ ${book._id} · ${book.title} · empty cover - skipped`);
      report.skipped++;
      continue;
    }
    console.log(`  ${DRY ? "would move" : "→"} ${book._id} · ${book.title} · ${mime} · ${data.length}B`);
    if (DRY) continue;
    keep(`cover-${book._id}.bin`, data);
    const fileId = new mongoose.Types.ObjectId();
    const storageKey = `library/${book._id}/${crypto.randomUUID()}`;
    const digest = await putVerified(storageKey, data, mime);
    const now = new Date();
    await files.insertOne({ _id: fileId, name: `${book.title || "cover"}.${mime.split("/")[1] || "jpg"}`, mime, size: data.length, status: "ready", storageKey, family: "library", owner: { kind: "book", id: book._id }, attachedAt: book.cover.savedAt || now, savedAt: book.cover.savedAt || now, createdAt: now, updatedAt: now, allowedAccounts: [], uploadedBy: { label: "migrateFilesToS3" } });
    await col("books").updateOne({ _id: book._id }, { $set: { "cover.file": fileId, "cover.size": data.length, "cover.mime": mime } });
    ledger.push({ kind: "cover", bookId: String(book._id), title: book.title, fileId: String(fileId), storageKey, mime, size: data.length, sha256: digest, at: now });
    saveLedger();
    report.covers++;
  }
  for (const b of await col("books").find({ "cover.storedName": { $exists: true }, "cover.file": { $exists: false }, "cover.data": { $exists: false } }).project({ title: 1, cover: 1 }).toArray()) {
    console.log(`  ✗ ${b._id} · ${b.title} · the cover was a disk file (${b.cover.storedName}) the deploys wiped - lost`);
    report.lostDisk.push({ book: String(b._id), title: b.title, storedName: b.cover.storedName });
  }

  /* ── 3. waiver signatures ── */
  const waivers = await col("waivers").find({ $or: ["student", "witness", "guardian"].map((w) => ({ [`signatures.${w}`]: { $exists: true, $ne: null } })) }).toArray();
  console.log(`\n3. waivers with signatures in the database: ${waivers.length}`);
  for (const w of waivers) {
    for (const who of ["student", "witness", "guardian"]) {
      const png = nonEmpty(toBuf(w.signatures?.[who]));
      if (!png || w.signatureKeys?.[who]) continue;
      const key = `waiver/${w._id}/${who}.png`;
      console.log(`  ${DRY ? "would move" : "→"} ${w._id} · ${who} · ${png.length}B`);
      if (DRY) continue;
      keep(`waiver-${w._id}-${who}.png`, png);
      const digest = await putVerified(key, png, "image/png");
      await col("waivers").updateOne({ _id: w._id }, { $set: { [`signatureKeys.${who}`]: key } });
      ledger.push({ kind: "signature", waiverId: String(w._id), who, key, size: png.length, sha256: digest, at: new Date() });
      saveLedger();
      report.signatures++;
    }
  }

  /* ── the disk pointers with nothing behind them ── */
  for (const i of await col("intakes").find({ "documents.file.storedName": { $exists: true } }).project({ documents: 1 }).toArray()) {
    for (const d of i.documents.filter((r) => r.file?.storedName && !r.file?.stored)) {
      console.log(`  ✗ intake ${i._id} · ${d.key} · a disk file (${d.file.storedName}) the deploys wiped - lost`);
      report.lostDisk.push({ intake: String(i._id), key: d.key, storedName: d.file.storedName });
    }
  }

  console.log(`\n${DRY ? "would move" : "moved"}: ${report.moved} files, ${report.covers} covers, ${report.signatures} signatures · orphans ${report.orphans.length} · lost disk files ${report.lostDisk.length} · skipped ${report.skipped}`);
  if (report.orphans.length) console.log("orphans:", JSON.stringify(report.orphans));
  if (!DRY) {
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`ledger: ${ledgerPath} (${ledger.length} entries) - check a few files in the app, then run with --unset`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
