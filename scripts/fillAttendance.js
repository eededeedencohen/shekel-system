/**
 * @file fillAttendance - random attendance for everyone
 * @module scripts/fillAttendance
 *
 * Eden (2026-10-12): "תמלא בצורה אקראית לכולם נוכחות חוץ
 * מבשבוע האחרון שבו אל תיגע". For every cycle with a weekly schedule and
 * every student who held a seat in it, every past meeting up to a week
 * ago gets an attendance record - a plausible random one: each student
 * has their own reliability (55-97% present), the rest splits between
 * "לא נכח" (announced) and "נעדר".
 *
 * Only GAPS are filled: a lesson that exists keeps every record it has; a
 * date that has an archive lesson (the old system's import) is left to
 * the archive; the last 7 days are not touched; the future is not touched.
 * Before writing, the `lessons` collection is dumped to
 * server/backups/attendance-<stamp>/ (EJSON - restorable with
 * scripts/backupJson.js's recipe).
 *
 * Usage:  node scripts/fillAttendance.js [--dry] [--days=7]
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const connectDB = require("../config/db");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const DRY = !!args.dry;
const KEEP_DAYS = Number(args.days) || 7;
const DAY = 86400000;

const utcMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const today = utcMidnight(new Date());
/** The last date we may touch: a week before today (the last 7 days stay as they are). */
const cutoff = new Date(today.getTime() - KEEP_DAYS * DAY);

/** A deterministic-ish reliability per student: 55%-97% present. */
const reliability = new Map();
const relOf = (id) => {
  const k = String(id);
  if (!reliability.has(k)) reliability.set(k, 0.55 + Math.random() * 0.42);
  return reliability.get(k);
};
const pickStatus = (studentId) => {
  const r = Math.random();
  const p = relOf(studentId);
  if (r < p) return "Present";
  // what is left splits 60/40 between "הודיע מראש" and "נעדר"
  return r < p + (1 - p) * 0.6 ? "AnnouncedAbsence" : "Missing";
};

/** Did the seat cover this date? */
function seated(en, date, cycle) {
  const from = en.joinedAt || en.registeredAt || cycle.startDate;
  if (from && utcMidnight(new Date(from)) > date) return false;
  if (en.status === "active") return true;
  if (en.status === "completed") return !en.leftAt || utcMidnight(new Date(en.leftAt)) >= date;
  if (en.status === "left") return !!en.leftAt && utcMidnight(new Date(en.leftAt)) >= date;
  return false; // reserved: no seat yet
}

async function backup(stamp) {
  const dir = path.join(__dirname, "..", "backups", `attendance-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const docs = await mongoose.connection.db.collection("lessons").find({}).toArray();
  fs.writeFileSync(path.join(dir, "lessons.ejson.json"), EJSON.stringify(docs, { relaxed: false }));
  return { dir, count: docs.length };
}

async function fill() {
  const cycles = await Cycle.find({ status: { $in: ["Active", "Completed"] }, "schedule.0": { $exists: true } }).select("startDate endDate schedule status").lean();
  const enrollments = await Enrollment.find({ status: { $in: ["active", "completed", "left"] } }).select("cycle student status joinedAt registeredAt leftAt slotId").lean();
  const byCycle = new Map();
  for (const en of enrollments) {
    const k = String(en.cycle);
    if (!byCycle.has(k)) byCycle.set(k, []);
    byCycle.get(k).push(en);
  }
  const stats = { cycles: 0, lessonsCreated: 0, lessonsFilled: 0, records: 0, skippedArchive: 0, students: new Set() };
  const bulk = [];
  const newLessons = [];

  for (const cycle of cycles) {
    const cohort = byCycle.get(String(cycle._id)) || [];
    if (!cohort.length) continue;
    const start = utcMidnight(new Date(cycle.startDate));
    const end = utcMidnight(new Date(cycle.endDate));
    const last = end < cutoff ? end : cutoff;
    if (last < start) continue;
    stats.cycles++;
    // every lesson this cycle already has (live + archive), by date
    const existing = await Lesson.find({ cycle: cycle._id, date: { $gte: start, $lte: last } }).select("date source attendance.student").lean();
    const live = new Map();
    const archiveDates = new Set();
    for (const l of existing) {
      const k = utcMidnight(new Date(l.date)).getTime();
      if (l.source === "archive") archiveDates.add(k);
      else live.set(k, l);
    }
    // walk the slots' weekdays from the start to the last allowed date
    const slots = (cycle.schedule || []).filter((s) => Number.isInteger(s.day));
    for (let t = start.getTime(); t <= last.getTime(); t += DAY) {
      const date = new Date(t);
      const todaySlots = slots.filter((s) => s.day === date.getUTCDay());
      if (!todaySlots.length) continue;
      if (archiveDates.has(t)) { stats.skippedArchive++; continue; }
      const slotIds = new Set(todaySlots.map((s) => String(s._id)));
      const who = cohort.filter((en) => (!en.slotId || slotIds.has(String(en.slotId))) && seated(en, date, cycle));
      if (!who.length) continue;
      const lesson = live.get(t);
      const have = new Set((lesson?.attendance || []).map((r) => String(r.student)));
      const fresh = who.filter((en) => !have.has(String(en.student))).map((en) => ({ student: en.student, status: pickStatus(en.student), isGuest: false }));
      if (!fresh.length) continue;
      fresh.forEach((r) => stats.students.add(String(r.student)));
      stats.records += fresh.length;
      if (lesson) {
        stats.lessonsFilled++;
        bulk.push({ updateOne: { filter: { _id: lesson._id, source: "live" }, update: { $push: { attendance: { $each: fresh } } } } });
      } else {
        stats.lessonsCreated++;
        newLessons.push({ cycle: cycle._id, date, source: "live", attendance: fresh });
      }
    }
  }
  if (!DRY) {
    if (newLessons.length) await Lesson.insertMany(newLessons, { ordered: false });
    if (bulk.length) await Lesson.bulkWrite(bulk, { ordered: false });
  }
  return stats;
}

(async () => {
  await connectDB();
  console.log(`${DRY ? "DRY RUN · " : ""}up to ${cutoff.toISOString().slice(0, 10)} (the last ${KEEP_DAYS} days untouched)`);
  if (!DRY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const b = await backup(stamp);
    console.log(`backup: ${b.count} lessons → ${b.dir}`);
  }
  const s = await fill();
  console.log(`${s.cycles} cycles · ${s.lessonsCreated} lessons created · ${s.lessonsFilled} existing lessons filled · ${s.records} attendance records · ${s.students.size} students · ${s.skippedArchive} archive dates left alone`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
