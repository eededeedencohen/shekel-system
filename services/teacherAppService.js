/**
 * @file teacherAppService - what a teacher's own account reads and writes
 * @module services/teacherAppService
 *
 * The teachers' app (Eden, 2026-11-16: "בוא נבנה עכשיו את אפליקציית המורים…
 * של מכללה לכל"). A teacher's account (StaffAccount kind "teacher", tied to
 * ONE Person who holds a Teacher profile) reaches this service and nothing
 * else of the API (utils/auth teacherGate). Everything here is keyed on the
 * account's own person id - no id of a teacher ever comes from the request.
 *
 *   board(personId)                       the teacher, the college courses he teaches, who sits in them (a name
 *                                         and a face - nothing else of a student), the lessons of the last weeks;
 *                                         and `me.teaching` - the HOURS he teaches in every program (a house's
 *                                         course is hours and a subject there, nothing more)
 *   markAttendance(personId, body)        marks on ONE day of ONE of his courses, merged into that day's lesson
 *   saveAvailability(personId, windows)   his own free windows (the programs' windows stay as the staff set them)
 *
 * מכללה לכל only: a course of a house (`hostel`) is reported by the house
 * and approved by the hostels coordinator (services/hostelReportService),
 * so it is not shown here and cannot be marked here.
 */

const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const AppError = require("../utils/AppError");
const { ATTENDANCE_STATUSES, ABSENCE_REASON_KEYS } = require("../utils/domain");

/** How far back a teacher sees and may still report (older days are the office's). */
const WINDOW_BACK_DAYS = 35;
const NOTE_MAX = 300;
const DAY_MS = 86400000;

/** Today in Israel, "YYYY-MM-DD" (the server's own clock is UTC). */
const todayStr = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
const utcDay = (str) => new Date(`${str}T00:00:00.000Z`);
const addDays = (str, n) => new Date(utcDay(str).getTime() + n * DAY_MS).toISOString().slice(0, 10);
/** A stored date as the day it means in Israel. */
const dayOf = (date) => (date ? todayStr(new Date(date)) : null);
/**
 * The first day a report is still taken for: the window, and never later than the first of LAST month - the app
 * offers this month's invoice and the last one's, and a lesson goes on an invoice only once it was reported
 * (Eden, 2026-11-18), so every lesson of those two months has to stay reportable.
 */
const reportFrom = (today) => {
  const window = addDays(today, -WINDOW_BACK_DAYS);
  const [y, m] = today.split("-").map(Number);
  const lastMonth = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
  return lastMonth < window ? lastMonth : window;
};

const studentView = (p) => ({ _id: String(p._id), firstName: p.firstName || "", lastName: p.lastName || "", gender: p.gender || null, avatar: p.avatar || null });
const windowView = (w) => ({ day: w.day, start: w.start, end: w.end, program: w.program || null });
const lessonView = (l) => ({
  _id: String(l._id),
  cycle: String(l.cycle),
  date: new Date(l.date).toISOString().slice(0, 10),
  marks: (l.attendance || []).map((r) => ({ student: String(r.student), status: r.status, note: r.note || "", reason: r.reason || null })),
});

async function teacherOf(personId) {
  if (!mongoose.isValidObjectId(personId)) throw AppError.of("TEACHER_PERSON_REQUIRED", 403);
  const person = await Person.findOne({ _id: personId, deletedAt: null });
  if (!person) throw AppError.of("TEACHER_PERSON_REQUIRED", 403);
  return person;
}

/** The college courses this teacher teaches now (or ended inside the window). */
const myCycles = (personId, today) =>
  Cycle.find({ teacher: personId, hostel: null, status: "Active", endDate: { $gte: utcDay(addDays(reportFrom(today), -1)) } });

/**
 * The hours this teacher teaches every week, in EVERY program - a house's course too (the app shows such a course
 * nowhere else, but its hours are just as taken). The board of the free hours keeps them shut (Eden, 2026-11-22:
 * "שיופיעו להם בזמינות כבר השעות שהם מלמדים אבל נעול - כלומר שאי אפשר לערוך"). The same lessons the staff's board
 * shows there (client TeacherAvailability `busy`): a course that has not ended, and a college course past its end
 * date that was still reported after it - it is taught in practice. Of a course: its hours, its subject, whose it
 * is - nothing of who sits in it.
 */
async function teachingOf(personId, today, collegeCycles, lessons) {
  const running = await Cycle.find({ teacher: personId, status: "Active", endDate: { $gte: utcDay(addDays(today, -1)) } })
    .select("subject schedule hostel endDate")
    .populate({ path: "subject", select: "name" })
    .populate({ path: "hostel", select: "name" })
    .lean();
  const lastReport = new Map();
  for (const l of lessons) {
    const day = new Date(l.date).toISOString().slice(0, 10);
    const key = String(l.cycle);
    if (!lastReport.has(key) || lastReport.get(key) < day) lastReport.set(key, day);
  }
  const taught = [
    ...running.filter((c) => dayOf(c.endDate) >= today),
    ...collegeCycles.filter((c) => dayOf(c.endDate) < today && (lastReport.get(String(c._id)) || "") > dayOf(c.endDate)),
  ];
  const out = [];
  for (const c of taught) {
    for (const s of c.schedule || []) {
      if (!Number.isInteger(s.day) || !s.start || !s.end || !(s.start < s.end)) continue;
      out.push({ day: s.day, start: s.start, end: s.end, subject: c.subject?.name || "", program: c.hostel ? "hostels" : "college", place: c.hostel?.name || "" });
    }
  }
  return out.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.program.localeCompare(b.program));
}

async function board(personId) {
  const person = await teacherOf(personId);
  const today = todayStr();
  const from = reportFrom(today);
  const [cycles, profile] = await Promise.all([
    myCycles(personId, today).populate({ path: "subject", select: "name" }).populate({ path: "schedule.room", select: "name" }).lean(),
    Profile.findOne({ person: person._id, kind: "Teacher" }).populate({ path: "subjects", select: "name" }).lean(),
  ]);
  const ids = cycles.map((c) => c._id);
  const [seats, lessons] = await Promise.all([
    // a held seat (`reserved`) is not an attendee; who left stays for the days he was still there
    Enrollment.find({ cycle: { $in: ids }, status: { $ne: "reserved" } }).select("cycle student status slotId joinedAt registeredAt leftAt").populate({ path: "student", select: "firstName lastName gender avatar deletedAt" }).lean(),
    Lesson.find({ cycle: { $in: ids }, source: "live", date: { $gte: utcDay(from), $lte: utcDay(today) } }).select("cycle date attendance.student attendance.status attendance.note attendance.reason").lean(),
  ]);
  const teaching = await teachingOf(personId, today, cycles, lessons);
  return {
    today,
    // the lists and the red numbers look this far back; a report itself is taken from `reportFrom`
    windowDays: WINDOW_BACK_DAYS,
    reportFrom: from,
    me: {
      _id: String(person._id),
      firstName: person.firstName || "",
      lastName: person.lastName || "",
      gender: person.gender || null,
      avatar: person.avatar || null,
      phone: person.phone || "",
      email: person.email && !person.email.endsWith("placeholder.local") ? person.email : "",
      subjects: (profile?.subjects || []).map((s) => s?.name).filter(Boolean),
      availability: (person.availability || []).map(windowView),
      // the hours he teaches, every program: shut on the board of his free hours
      teaching,
    },
    cycles: cycles.map((c) => ({
      _id: String(c._id),
      subject: c.subject?.name || "",
      format: c.matching?.format || null,
      startDate: dayOf(c.startDate),
      endDate: dayOf(c.endDate),
      place: c.venue?.label || "",
      schedule: (c.schedule || []).map((s) => ({ _id: String(s._id), day: s.day, start: s.start, end: s.end, room: s.room?.name || "" })),
    })),
    seats: seats
      .filter((e) => e.student && !e.student.deletedAt)
      .map((e) => ({
        cycle: String(e.cycle),
        slotId: e.slotId ? String(e.slotId) : null,
        status: e.status,
        from: dayOf(e.joinedAt || e.registeredAt),
        until: dayOf(e.leftAt),
        student: studentView(e.student),
      })),
    lessons: lessons.map(lessonView),
  };
}

/**
 * PUT /api/teacher/attendance - { cycle, date: "YYYY-MM-DD", marks: [{ student, status, note?, reason? }] }.
 * `status: null` takes a mark back. Only the students named are touched: the day's other marks stay.
 * `reason` (Eden, 2026-11-17: "כמו בנוכחות של ההוסטלים… יש גם סיבה למה לא הגיע") is one of ABSENCE_REASONS on an
 * absence that was announced; whoever came, and whoever said nothing, carry none.
 * The reason is a MUST there (Eden, 2026-11-17: "אנחנו מחייבים סיבה… ואם הוא סימן אחר אז יהיה חובה לרשום את
 * הפירוט"): an announced absence is not kept without one, and "אחר" not without its words - they are the mark's
 * `note`, as in the houses' reports. A row that already has its reason keeps it when the mark is sent again bare.
 */
async function markAttendance(personId, body) {
  await teacherOf(personId);
  const { cycle: cycleId, date, marks } = body || {};
  if (!mongoose.isValidObjectId(cycleId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !Array.isArray(marks) || !marks.length || marks.length > 80) {
    throw AppError.of("MISSING_FIELDS", 400, "cycle, date, marks");
  }
  const day = utcDay(date);
  if (Number.isNaN(day.getTime())) throw AppError.of("INVALID_DATE", 400);
  // his own course, of the college - never trusted from the request
  const cycle = await Cycle.findOne({ _id: cycleId, teacher: personId, hostel: null, status: "Active" }).lean();
  if (!cycle) throw AppError.of("LESSON_NOT_YOURS", 403);

  const today = todayStr();
  const inWindow = date <= today && date >= reportFrom(today);
  // the course's own dates, a day of grace on each side (a date kept at local midnight reads a day off in UTC)
  const inCourse = (!cycle.startDate || date >= addDays(dayOf(cycle.startDate), -1)) && (!cycle.endDate || date <= addDays(dayOf(cycle.endDate), 1));
  const meets = (cycle.schedule || []).some((s) => s.day === day.getUTCDay());
  if (!inWindow || !inCourse || !meets) throw AppError.of("LESSON_DATE_INVALID", 400);

  // who may be marked: whoever held a seat in this course on that day
  const seats = await Enrollment.find({ cycle: cycle._id, status: { $ne: "reserved" } }).select("student joinedAt registeredAt leftAt").lean();
  const seated = new Set(
    seats
      .filter((e) => {
        const start = dayOf(e.joinedAt || e.registeredAt);
        const end = dayOf(e.leftAt);
        return (!start || date >= start) && (!end || date <= end);
      })
      .map((e) => String(e.student))
  );
  const clean = new Map();
  for (const m of marks) {
    const student = String(m?.student || "");
    if (!mongoose.isValidObjectId(student) || !seated.has(student)) throw AppError.of("LESSON_STUDENT_INVALID", 400);
    const status = m.status == null || m.status === "" ? null : m.status;
    if (status !== null && !ATTENDANCE_STATUSES.includes(status)) throw AppError.of("ATTENDANCE_INVALID", 400);
    if (m.note !== undefined && (typeof m.note !== "string" || m.note.length > NOTE_MAX)) throw AppError.of("ATTENDANCE_INVALID", 400);
    const reason = m.reason === undefined ? undefined : m.reason == null || m.reason === "" ? null : m.reason;
    if (reason != null && !ABSENCE_REASON_KEYS.includes(reason)) throw AppError.of("ATTENDANCE_REASON_INVALID", 400);
    clean.set(student, { status, note: m.note === undefined ? undefined : m.note.trim(), reason });
  }

  let lesson = await Lesson.findOne({ cycle: cycle._id, date: day, source: "live" });
  // an announced absence says why - checked before anything is written (or a lesson row made for nothing)
  for (const [student, m] of clean) {
    if (m.status !== "AnnouncedAbsence") continue;
    const was = (lesson?.attendance || []).find((r) => String(r.student) === student) || null;
    const reason = m.reason !== undefined ? m.reason : was?.status === "AnnouncedAbsence" ? was.reason || null : null;
    if (!reason) throw AppError.of("ATTENDANCE_REASON_REQUIRED", 400);
    if (reason === "other" && !(m.note !== undefined ? m.note : was?.note || "")) throw AppError.of("ATTENDANCE_REASON_DETAIL_REQUIRED", 400);
  }
  // that day's lesson, made when it is not there yet (one live lesson per course per day - the index decides a race)
  if (!lesson) {
    try {
      lesson = await Lesson.create({ cycle: cycle._id, date: day, attendance: [] });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      lesson = await Lesson.findOne({ cycle: cycle._id, date: day, source: "live" });
    }
  }
  for (const [student, m] of clean) {
    const at = lesson.attendance.findIndex((r) => String(r.student) === student);
    if (m.status === null) {
      if (at >= 0) lesson.attendance.splice(at, 1);
      continue;
    }
    // a reason is of an absence that was ANNOUNCED (Eden, 2026-11-17, of "לא הגיע ולא הודיע": "במקרה כזה אין למה"):
    // whoever came, and whoever did not come and said nothing, carry none - whatever was there before
    const reason = m.status === "AnnouncedAbsence" ? m.reason : null;
    if (at >= 0) {
      // the words of an announced absence are its reason's: a mark that stops being one drops them with the reason
      const leftAbsence = lesson.attendance[at].status === "AnnouncedAbsence" && m.status !== "AnnouncedAbsence";
      lesson.attendance[at].status = m.status;
      if (m.note !== undefined) lesson.attendance[at].note = m.note;
      else if (leftAbsence) lesson.attendance[at].note = "";
      if (reason !== undefined) lesson.attendance[at].reason = reason;
    } else {
      lesson.attendance.push({ student, status: m.status, ...(m.note ? { note: m.note } : {}), ...(reason ? { reason } : {}) });
    }
  }
  await lesson.save();
  return lessonView(lesson);
}

/**
 * The sessions of a month that may not go on an invoice yet (Eden, 2026-11-18: "השיעורים שהוא לא דיווח נוכחות
 * עליהם לא ייתאפשר שהם יסומנו"). `sessions`: [{ _id, cycle, date }]. Answers Map(session id → "ahead" | "report"):
 *   - "ahead": the lesson has not taken place yet;
 *   - "report": it took place, the teacher can report it here, and has not.
 * A lesson with a mark on it is free. So is one that cannot be reported in the app at all - a course that is no
 * longer his active college course, a day nobody was seated in it - or it would be shut out of every invoice.
 */
async function sessionsWaiting(personId, sessions) {
  const out = new Map();
  if (!sessions.length) return out;
  const today = todayStr();
  const from = reportFrom(today);
  const cycleIds = [...new Set(sessions.map((s) => String(s.cycle)))];
  const [lessons, cycles] = await Promise.all([
    Lesson.find({ source: "live", cycle: { $in: cycleIds }, date: { $in: sessions.map((s) => s.date) }, "attendance.0": { $exists: true } }).select("cycle date").lean(),
    Cycle.find({ _id: { $in: cycleIds }, teacher: personId, hostel: null, status: "Active" }).select("_id").lean(),
  ]);
  const reported = new Set(lessons.map((l) => `${l.cycle}|${new Date(l.date).toISOString()}`));
  const mine = new Set(cycles.map((c) => String(c._id)));
  const seats = await Enrollment.find({ cycle: { $in: [...mine] }, status: { $ne: "reserved" } }).select("cycle joinedAt registeredAt leftAt").lean();
  for (const s of sessions) {
    if (reported.has(`${s.cycle}|${new Date(s.date).toISOString()}`)) continue;
    const date = dayOf(s.date);
    if (date > today) {
      out.set(String(s._id), "ahead");
      continue;
    }
    if (date < from || !mine.has(String(s.cycle))) continue;
    const seated = seats.some((e) => {
      if (String(e.cycle) !== String(s.cycle)) return false;
      const start = dayOf(e.joinedAt || e.registeredAt);
      const end = dayOf(e.leftAt);
      return (!start || date >= start) && (!end || date <= end);
    });
    if (seated) out.set(String(s._id), "report");
  }
  return out;
}

/** PATCH /api/teacher/availability - { windows: [{ day, start, end }] }: the teacher's OWN windows, whole. */
async function saveAvailability(personId, windows) {
  if (!Array.isArray(windows) || windows.length > 60) throw AppError.of("MISSING_FIELDS", 400, "windows");
  const person = await teacherOf(personId);
  // what a program marked for itself is the staff's to move (personController checkAvailability) - kept as it is
  const kept = (person.availability || []).filter((w) => w.program).map(windowView);
  const own = windows.map((w) => ({ day: Number(w?.day), start: String(w?.start || ""), end: String(w?.end || ""), program: null }));
  person.availability = [...kept, ...own];
  try {
    await person.save();
  } catch (err) {
    if (err?.name === "ValidationError") throw AppError.of("AVAILABILITY_INVALID", 400);
    throw err;
  }
  return (person.availability || []).map(windowView);
}

module.exports = { board, markAttendance, saveAvailability, sessionsWaiting, reportFrom, todayStr, addDays, WINDOW_BACK_DAYS };
