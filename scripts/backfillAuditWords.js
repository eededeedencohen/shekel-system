/**
 * @file backfillAuditWords - the audit rows written before the words, told again
 *
 * Eden (2026-10-29, on the first rows: "אחד טוב אבל תתקן את הישנים"). The
 * rows written before utils/auditDetails have an empty `summary`: their
 * kept payload is compact (ids at the top level survive, nested objects
 * were folded to "{…}"), so each row is told again from what survived:
 * ids become names, keys and values Hebrew, the target gets its name.
 *
 * Attendance rows are special: `records` was folded, but the lesson
 * itself (the same cycle and day) still holds every mark in the order the
 * client sent them, and every write of that day sent the whole list - so
 * the first N marks of the lesson are the N records of a row that sent N.
 * Such a summary ends with "שוחזר מהשיעור", honestly.
 *
 * "What changed" cannot be known for an old edit (the target's picture is
 * today's) and stays empty. A ledger of every row's before / after goes to
 * server/backups/audit-words-<date>/ledger.json.
 *
 *   node scripts/backfillAuditWords.js --dry   # prints, writes nothing
 *   node scripts/backfillAuditWords.js         # writes
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const AuditEvent = require("../models/AuditEvent");
const Lesson = require("../models/Lesson");
const { details, snapshot } = require("../utils/auditDetails");

const DRY = process.argv.includes("--dry");
const DAY = 86400000;

const dir = path.join(__dirname, "..", "backups", `audit-words-${new Date().toISOString().slice(0, 10)}`);
const ledgerPath = path.join(dir, "ledger.json");

/** The lesson's marks for a cycle and a day, in the order the client sent them. */
async function lessonRecords(cycle, date) {
  if (!mongoose.isValidObjectId(String(cycle || "")) || !/^\d{4}-\d{2}-\d{2}/.test(String(date || ""))) return null;
  const day = new Date(String(date).slice(0, 10) + "T00:00:00.000Z");
  const lesson = await Lesson.findOne({ cycle, source: "live", date: { $gte: new Date(day.getTime() - DAY), $lt: new Date(day.getTime() + 2 * DAY) } })
    .sort({ date: 1 })
    .lean();
  if (!lesson) return null;
  return (lesson.attendance || []).map((r) => ({
    student: String(r.student),
    status: r.status,
    ...(r.note ? { note: r.note } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.progressRating != null ? { progressRating: r.progressRating } : {}),
    ...(r.isGuest ? { isGuest: true } : {}),
  }));
}

(async () => {
  await connectDB();
  const rows = await AuditEvent.find({ $or: [{ summary: "" }, { summary: { $exists: false } }] }).sort({ at: 1 }).lean();
  console.log(`${DRY ? "[dry] " : ""}${rows.length} rows without words`);
  const ledger = [];
  let done = 0;
  for (const row of rows) {
    const body = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? { ...row.payload } : {};
    let reconstructed = false;
    if (row.route === "/lessons/attendance" && body.cycle && body.date) {
      const marks = await lessonRecords(body.cycle, body.date);
      if (marks) {
        const n = Array.isArray(body.records) ? body.records.length : marks.length;
        body.records = marks.slice(0, Math.max(1, Math.min(n, marks.length)));
        reconstructed = true;
      }
    }
    let before = null;
    try {
      before = await snapshot(row.route, row.path);
    } catch {
      before = null;
    }
    let words;
    try {
      words = await details({ method: row.method, path: row.path, route: row.route, body, answer: null, before, backfill: true });
    } catch (err) {
      console.log(`  skip ${row._id} (${row.method} ${row.path}): ${err.message}`);
      continue;
    }
    if (reconstructed && words.summary) words.summary = `${words.summary} · שוחזר מהשיעור`;
    const target = { ...(row.target || {}) };
    if (!target.label && words.label) target.label = words.label.slice(0, 120);
    const after = { summary: words.summary, facts: words.facts, changes: [], target };
    ledger.push({ _id: String(row._id), at: row.at, method: row.method, path: row.path, before: { summary: row.summary || "", facts: row.facts || [], changes: row.changes || [], target: row.target }, after });
    console.log(`  ${new Date(row.at).toISOString().slice(0, 16)} ${row.title}${target.label ? ` «${target.label}»` : ""}: ${after.summary || "(no words)"}${after.facts.length ? ` [${after.facts.length} facts]` : ""}`);
    if (!DRY) {
      await AuditEvent.updateOne({ _id: row._id }, { $set: after });
      done += 1;
    }
  }
  if (!DRY) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(`${done} rows updated · ledger ${ledgerPath}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
