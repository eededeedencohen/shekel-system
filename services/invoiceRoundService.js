/**
 * @file invoiceRoundService - the monthly invoice round (שמרית's round,
 * 2026-10-14; Eden: "תשלחי להם קישור זמני… יהיה להם פירוט של השיעורים
 * שלהם, יוכלו לסמן איזה שיעורים, לקשר את זה לחשבונית… בדשבורד: כמה מורים
 * העלו, כמה העלו הכל, כמה חלק, כמה אפילו לא פתחו").
 *
 * The coordinator opens a month for a program (hostels first): every
 * teacher of a course live in that month gets an InvoiceRequest - a token,
 * the month's planned sessions of their courses (from the weekly slots).
 * She sends each link by WhatsApp. Behind the link the teacher marks each
 * session התקיים / לא התקיים, uploads the invoice picture written on the
 * taught sessions (a Lesson row is made for a taught session that has
 * none yet - the coordinator's attendance report later lands on the same
 * row), and presses סיימתי. The coordinator's page reads where everyone
 * stands, what the teacher said against what she reported, and closes
 * the month with the mail.
 *
 * The staff side answers through `roundView`; the teacher's side through
 * `publicView` - the teacher never sees the other teachers, the attendance
 * or the invoices' bookkeeping.
 * @module services/invoiceRoundService
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const InvoiceRound = require("../models/InvoiceRound");
const InvoiceRequest = require("../models/InvoiceRequest");
const Invoice = require("../models/Invoice");
const InvoiceLesson = require("../models/InvoiceLesson");
const Lesson = require("../models/Lesson");
const Cycle = require("../models/Cycle");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const invoices = require("./invoiceService");
const { Profile } = require("../models/profiles");
const { INVOICE_ROUND_PROGRAMS, INVOICE_ROUND_PROGRAM_LABELS, INVOICE_LINK_DAYS, INVOICE_SESSION_STATES, INVOICE_REQUEST_STATUS_LABELS, INVOICE_DUE_DAY } = require("../utils/domain");

const DAY_MS = 24 * 3600 * 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const isId = (v) => mongoose.isValidObjectId(v);
const makeToken = () => crypto.randomBytes(18).toString("base64url");
const clean = (s, max = 200) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);

/* ───────────────────────── days and months ───────────────────────── */

/** "2026-10" → "אוקטובר 2026" */
function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return `${HE_MONTHS[m - 1]} ${y}`;
}

/** The calendar day of a stored date, in Israel: "2026-10-01". Lessons sit at UTC midnight; cycle dates at local midnight. */
function dayKey(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}

/** The UTC-midnight date of a "YYYY-MM-DD" key - how Lesson.date is stored. */
const utcOf = (key) => new Date(`${key}T00:00:00.000Z`);

/** The day the invoices must be in (שמרית: the 29th), as a UTC-midnight date of the month. */
function dueOf(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(INVOICE_DUE_DAY, last)));
}

/** Every day of the month as keys, first to last. */
function daysOfMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const out = [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
}

/**
 * The month's planned sessions of one cycle: its weekly slots on the
 * month's days, inside the cycle's own dates. Sorted by day, then start.
 */
function plannedSessions(cycle, month) {
  const slots = (cycle.schedule || []).filter((s) => Number.isInteger(s.day) && s.start && s.end);
  if (!slots.length) return [];
  const from = cycle.startDate ? dayKey(cycle.startDate) : null;
  const to = cycle.endDate ? dayKey(cycle.endDate) : null;
  const out = [];
  for (const key of daysOfMonth(month)) {
    if ((from && key < from) || (to && key > to)) continue;
    const dow = utcOf(key).getUTCDay();
    for (const s of slots) {
      if (s.day !== dow) continue;
      out.push({ cycle: cycle._id, date: utcOf(key), slotId: s._id, start: s.start, end: s.end, state: null, lesson: null });
    }
  }
  return out.sort((a, b) => a.date - b.date || String(a.start).localeCompare(String(b.start)));
}

/* ───────────────────────── opening a month ───────────────────────── */

const programCond = (program) => (program === "hostels" ? { hostel: { $ne: null } } : { hostel: null });

/** The live cycles of the program in the month, with a teacher. */
async function cyclesOfMonth({ world, program, month }) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - DAY_MS); // a day of slack on both ends: local midnights
  const end = new Date(Date.UTC(y, m, 0) + 2 * DAY_MS);
  return Cycle.find({
    world,
    ...programCond(program),
    status: { $ne: "Cancelled" },
    teacher: { $ne: null },
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).lean();
}

/** Link the sessions that already have a lesson row (reported, or made by an earlier link). */
async function attachLessons(world, sessions) {
  const open = sessions.filter((s) => !s.lesson);
  if (!open.length) return;
  const cycleIds = [...new Set(open.map((s) => String(s.cycle)))];
  const dates = [...new Set(open.map((s) => s.date.toISOString()))].map((d) => new Date(d));
  const lessons = await Lesson.find({ world, source: "live", cycle: { $in: cycleIds }, date: { $in: dates } })
    .select("_id cycle date")
    .lean();
  const byKey = new Map(lessons.map((l) => [`${l.cycle}|${l.date.toISOString()}`, l._id]));
  for (const s of open) {
    const id = byKey.get(`${s.cycle}|${s.date.toISOString()}`);
    if (id) s.lesson = id;
  }
}

async function openRound({ world, month, program = "hostels", by }) {
  if (!MONTH_RE.test(String(month || ""))) throw AppError.of("INVOICE_ROUND_MONTH", 400);
  if (!INVOICE_ROUND_PROGRAMS.includes(program)) throw AppError.of("INVOICE_ROUND_PROGRAM", 400);
  if (await InvoiceRound.exists({ world, month, program })) throw AppError.of("INVOICE_ROUND_EXISTS", 409);
  const cycles = await cyclesOfMonth({ world, program, month });
  const byTeacher = new Map();
  for (const c of cycles) {
    const sessions = plannedSessions(c, month);
    if (!sessions.length) continue;
    const t = String(c.teacher);
    if (!byTeacher.has(t)) byTeacher.set(t, []);
    byTeacher.get(t).push(...sessions);
  }
  if (!byTeacher.size) throw AppError.of("INVOICE_ROUND_NO_TEACHERS", 400);
  const round = await InvoiceRound.create({ world, month, program, openedBy: clean(by, 80) });
  const expiresAt = new Date(Date.now() + INVOICE_LINK_DAYS * DAY_MS);
  for (const [teacher, sessions] of byTeacher) {
    sessions.sort((a, b) => a.date - b.date || String(a.start).localeCompare(String(b.start)));
    await attachLessons(world, sessions);
    await InvoiceRequest.create({ world, round: round._id, teacher, token: makeToken(), expiresAt, sessions });
  }
  return roundView(await loadRound({ world, roundId: round._id }));
}

/* ───────────────────────── reading ───────────────────────── */

async function loadRound({ world, roundId }) {
  const round = isId(roundId) && (await InvoiceRound.findOne({ _id: roundId, world }));
  if (!round) throw AppError.of("NOT_FOUND", 404, "סבב חשבוניות");
  return round;
}

async function loadRequest({ world, roundId, requestId }) {
  const r = isId(requestId) && (await InvoiceRequest.findOne({ _id: requestId, world, ...(roundId && { round: roundId }) }));
  if (!r) throw AppError.of("NOT_FOUND", 404, "קישור של מורה");
  return r;
}

/** Where a request stands - from the facts, never set by hand (INVOICE_REQUEST_STATUSES). */
function statusOf(r, invoiceCount) {
  if (r.completedAt) return "done";
  if (invoiceCount > 0 || (r.sessions || []).some((s) => s.state)) return "partial";
  if (r.openedAt) return "opened";
  if (r.sentAt) return "sent";
  return "new";
}

/**
 * The facts around a list of requests: their cycles (named), their
 * invoices (shaped, by request), and for every session whether a lesson
 * exists and whether attendance was reported on it.
 */
async function factsOf(world, requests) {
  for (const r of requests) await attachLessons(world, r.sessions);
  const cycleIds = [...new Set(requests.flatMap((r) => r.sessions.map((s) => String(s.cycle))))];
  const lessonIds = [...new Set(requests.flatMap((r) => r.sessions.map((s) => s.lesson && String(s.lesson)).filter(Boolean)))];
  const [cycles, lessons, invs, billed] = await Promise.all([
    Cycle.find({ _id: { $in: cycleIds } }).select("subject hostel schedule").populate("subject", "name").populate("hostel", "name kind").lean(),
    Lesson.find({ _id: { $in: lessonIds } }).select("_id attendance").lean(),
    Invoice.find({ world, request: { $in: requests.map((r) => r._id) } }).sort({ uploadedAt: -1 }).lean(),
    InvoiceLesson.find({ lesson: { $in: lessonIds } }).select("lesson invoice").lean(),
  ]);
  const shaped = await invoices.shape(world, invs);
  const invoicesByRequest = new Map();
  for (const i of shaped) {
    const k = String(i.request);
    if (!invoicesByRequest.has(k)) invoicesByRequest.set(k, []);
    invoicesByRequest.get(k).push(i);
  }
  return {
    cycleById: new Map(cycles.map((c) => [String(c._id), c])),
    reported: new Set(lessons.filter((l) => (l.attendance || []).length > 0).map((l) => String(l._id))),
    invoicesByRequest,
    invoiceByLesson: new Map(billed.map((b) => [String(b.lesson), String(b.invoice)])),
  };
}

const cycleView = (c) => (c ? { _id: c._id, subject: c.subject ? { _id: c.subject._id, name: c.subject.name } : null, hostel: c.hostel ? { _id: c.hostel._id, name: c.hostel.name, kind: c.hostel.kind } : null } : null);
const cycleName = (c) => (c ? `${c.subject?.name || "קורס"}${c.hostel ? ` · ${c.hostel.kind === "community" ? "קהילת" : "הוסטל"} ${c.hostel.name}` : ""}` : "קורס");

function sessionView(s, facts) {
  const lesson = s.lesson ? String(s.lesson) : null;
  return {
    _id: s._id,
    cycle: cycleView(facts.cycleById.get(String(s.cycle))),
    date: s.date,
    start: s.start,
    end: s.end,
    state: s.state || null,
    markedAt: s.markedAt || null,
    lesson,
    reported: !!(lesson && facts.reported.has(lesson)),
    invoice: lesson ? facts.invoiceByLesson.get(lesson) || null : null,
  };
}

function countsOf(sessions) {
  const c = { sessions: sessions.length, taught: 0, notHeld: 0, unmarked: 0, reported: 0, markedNotReported: 0, reportedNotMarked: 0, billed: 0 };
  for (const s of sessions) {
    if (s.state === "taught") c.taught++;
    else if (s.state === "notHeld") c.notHeld++;
    else c.unmarked++;
    if (s.reported) c.reported++;
    if (s.state === "taught" && !s.reported) c.markedNotReported++;
    if (s.reported && s.state !== "taught") c.reportedNotMarked++;
    if (s.invoice) c.billed++;
  }
  return c;
}

function requestView(r, facts, teacher, rate = null) {
  const invs = facts.invoicesByRequest.get(String(r._id)) || [];
  const sessions = r.sessions.map((s) => sessionView(s, facts));
  const status = statusOf(r, invs.length);
  return {
    _id: r._id,
    round: r.round,
    // `rate` = ₪ per session in the hostels (the Teacher profile) - the page checks the invoice's sum against taught × rate
    teacher: teacher ? { _id: teacher._id, firstName: teacher.firstName, lastName: teacher.lastName, gender: teacher.gender || null, phone: teacher.phone || null, rate } : { _id: r.teacher, rate },
    token: r.token,
    expiresAt: r.expiresAt,
    linkLive: r.expiresAt.getTime() > Date.now(),
    sentAt: r.sentAt || null,
    sentBy: r.sentBy || null,
    openedAt: r.openedAt || null,
    lastOpenedAt: r.lastOpenedAt || null,
    completedAt: r.completedAt || null,
    note: r.note || null,
    status,
    statusLabel: INVOICE_REQUEST_STATUS_LABELS[status],
    counts: countsOf(sessions),
    sessions,
    invoices: invs,
  };
}

/** The staff shape of a round: the month, its requests with everything derived, and the totals. */
async function roundView(round) {
  const requests = await InvoiceRequest.find({ round: round._id }).lean();
  const facts = await factsOf(round.world, requests);
  const teacherIds = requests.map((r) => r.teacher);
  const [teachers, profiles] = await Promise.all([
    Person.find({ _id: { $in: teacherIds } }).select("firstName lastName gender phone").lean(),
    Profile.find({ person: { $in: teacherIds }, kind: "Teacher" }).select("person hostelRate").lean(),
  ]);
  const teacherById = new Map(teachers.map((t) => [String(t._id), t]));
  const rateOf = new Map(profiles.map((p) => [String(p.person), p.hostelRate ?? null]));
  const rows = requests
    .map((r) => requestView(r, facts, teacherById.get(String(r.teacher)), round.program === "hostels" ? rateOf.get(String(r.teacher)) ?? null : null))
    .sort((a, b) => `${a.teacher.firstName} ${a.teacher.lastName}`.localeCompare(`${b.teacher.firstName} ${b.teacher.lastName}`, "he"));
  const counts = { teachers: rows.length, new: 0, sent: 0, opened: 0, partial: 0, done: 0, invoices: 0, mismatches: 0 };
  for (const r of rows) {
    counts[r.status]++;
    counts.invoices += r.invoices.length;
    counts.mismatches += r.counts.markedNotReported + r.counts.reportedNotMarked;
  }
  return {
    _id: round._id,
    world: round.world,
    month: round.month,
    monthLabel: monthLabel(round.month),
    dueAt: dueOf(round.month),
    program: round.program,
    programLabel: INVOICE_ROUND_PROGRAM_LABELS[round.program],
    openedAt: round.openedAt,
    openedBy: round.openedBy || null,
    mail: { sentAt: round.mail?.sentAt || null, sentBy: round.mail?.sentBy || null },
    note: round.note || null,
    counts,
    requests: rows,
  };
}

/** Every round of the programs the lens may see, newest month first. */
async function listRounds({ world, programs = null }) {
  const filter = { world };
  if (programs) filter.program = { $in: programs };
  const rounds = await InvoiceRound.find(filter).sort({ month: -1, program: 1 });
  const out = [];
  for (const r of rounds) out.push(await roundView(r));
  return out;
}

async function getRound({ world, roundId }) {
  return roundView(await loadRound({ world, roundId }));
}

/* ───────────────────────── the coordinator's moves ───────────────────────── */

/** She sent the link (by WhatsApp, outside the app) - noted with her name. */
async function markSent({ world, roundId, requestId, by }) {
  const r = await loadRequest({ world, roundId, requestId });
  r.sentAt = new Date();
  r.sentBy = clean(by, 80);
  await r.save();
  return getRound({ world, roundId });
}

/** The link open again for `days` from now (the same address - a message already sent keeps working). */
async function renew({ world, roundId, requestId, days }) {
  const r = await loadRequest({ world, roundId, requestId });
  const n = Number(days) > 0 ? Math.min(Number(days), 90) : INVOICE_LINK_DAYS;
  r.expiresAt = new Date(Date.now() + n * DAY_MS);
  await r.save();
  return getRound({ world, roundId });
}

/** The teacher pressed סיימתי too soon - the coordinator opens it back. */
async function reopen({ world, roundId, requestId }) {
  const r = await loadRequest({ world, roundId, requestId });
  r.completedAt = undefined;
  await r.save();
  return getRound({ world, roundId });
}

/** The mail with the PDFs went to the bookkeeping (or did not, after all). */
async function setMail({ world, roundId, sent, by }) {
  const round = await loadRound({ world, roundId });
  round.mail = sent ? { sentAt: new Date(), sentBy: clean(by, 80) } : {};
  await round.save();
  return roundView(round);
}

async function setNote({ world, roundId, note }) {
  const round = await loadRound({ world, roundId });
  round.note = clean(note, 1000);
  await round.save();
  return roundView(round);
}

/** A round opened by mistake: gone with its requests - unless an invoice came through one of them. */
async function deleteRound({ world, roundId }) {
  const round = await loadRound({ world, roundId });
  const requests = await InvoiceRequest.find({ round: round._id }).select("_id").lean();
  if (await Invoice.exists({ request: { $in: requests.map((r) => r._id) } })) throw AppError.of("INVOICE_ROUND_HAS_INVOICES", 409);
  await InvoiceRequest.deleteMany({ round: round._id });
  await InvoiceRound.deleteOne({ _id: round._id });
}

/* ───────────────────────── the teacher's side (behind the link) ───────────────────────── */

async function resolveToken({ world, token }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("INVOICE_LINK_INVALID", 404);
  const r = await InvoiceRequest.findOne({ world, token: t });
  if (!r) throw AppError.of("INVOICE_LINK_INVALID", 404);
  if (!r.linkLive()) throw AppError.of("INVOICE_LINK_EXPIRED", 410);
  return r;
}

/** The teacher opened the page - noted once as the first time, always as the last (best effort). */
async function noteOpened(r) {
  const now = new Date();
  const first = !r.openedAt;
  if (first) r.openedAt = now;
  r.lastOpenedAt = now;
  try {
    await r.save();
  } catch (err) {
    console.error("invoice link: the opening was not noted -", err.message);
    if (first) r.openedAt = undefined;
  }
  return r;
}

/** What the teacher's page reads: their month, their sessions, their invoices - nothing of anyone else. */
async function publicView(r) {
  const [round, teacher] = await Promise.all([InvoiceRound.findById(r.round).lean(), Person.findById(r.teacher).select("firstName lastName gender").lean()]);
  const facts = await factsOf(r.world, [r]);
  const sessions = r.sessions.map((s) => sessionView(s, facts));
  const groups = new Map();
  for (const s of sessions) {
    const k = String(s.cycle?._id || "");
    if (!groups.has(k)) groups.set(k, { cycle: s.cycle, name: cycleName(facts.cycleById.get(k)), sessions: [] });
    groups.get(k).sessions.push({ _id: s._id, date: s.date, start: s.start, end: s.end, state: s.state, invoice: s.invoice });
  }
  const invs = (facts.invoicesByRequest.get(String(r._id)) || []).map((i) => ({
    _id: i._id,
    uploadedAt: i.uploadedAt,
    file: i.file ? { name: i.file.name, mime: i.file.mime, size: i.file.size } : null,
    lessons: i.lessons.map((l) => ({ _id: l._id, date: l.date, name: cycleName(facts.cycleById.get(String(l.cycle))) })),
  }));
  return {
    teacher: { firstName: teacher?.firstName || "", gender: teacher?.gender || null },
    month: round.month,
    monthLabel: monthLabel(round.month),
    dueAt: dueOf(round.month),
    program: round.program,
    programLabel: INVOICE_ROUND_PROGRAM_LABELS[round.program],
    coordinator: r.sentBy || round.openedBy || null,
    expiresAt: r.expiresAt,
    done: !!r.completedAt,
    completedAt: r.completedAt || null,
    note: r.note || null,
    counts: countsOf(sessions),
    courses: [...groups.values()],
    invoices: invs,
    maxImageBytes: invoices.MAX_IMAGE_BYTES,
  };
}

const assertOpen = (r) => {
  if (r.completedAt) throw AppError.of("INVOICE_LINK_DONE", 400);
};

/** The teacher's word on sessions: [{ id, state }] with state taught / notHeld / null. A billed session stays taught. */
async function setSessions(r, marks) {
  assertOpen(r);
  if (!Array.isArray(marks)) throw AppError.of("INVOICE_SESSION_UNKNOWN", 400);
  const billed = new Set((await InvoiceLesson.find({ lesson: { $in: r.sessions.map((s) => s.lesson).filter(Boolean) } }).select("lesson").lean()).map((b) => String(b.lesson)));
  const now = new Date();
  for (const m of marks) {
    const s = r.sessions.id(m?.id);
    if (!s) throw AppError.of("INVOICE_SESSION_UNKNOWN", 400);
    const state = m.state == null || m.state === "" ? null : m.state;
    if (state !== null && !INVOICE_SESSION_STATES.includes(state)) throw AppError.of("INVOICE_SESSION_STATE", 400);
    if (s.lesson && billed.has(String(s.lesson))) continue;
    s.state = state;
    s.markedAt = now;
  }
  await r.save();
  return r;
}

/**
 * The invoice picture, written on the taught sessions named (or on every
 * taught session not yet billed). A taught session without a lesson row
 * gets one now - the same row the coordinator's report will fill.
 */
async function addInvoice(r, { imageData, imageName, sessionIds }) {
  assertOpen(r);
  const wanted = Array.isArray(sessionIds) && sessionIds.length ? new Set(sessionIds.map(String)) : null;
  const taught = r.sessions.filter((s) => s.state === "taught" && (!wanted || wanted.has(String(s._id))));
  if (wanted && taught.length !== wanted.size) throw AppError.of("INVOICE_SESSION_UNKNOWN", 400);
  if (!taught.length) throw AppError.of("INVOICE_NOTHING_TAUGHT", 400);
  await attachLessons(r.world, taught);
  for (const s of taught) {
    if (s.lesson) continue;
    const lesson = await Lesson.findOneAndUpdate(
      { cycle: s.cycle, date: s.date, source: "live" },
      { $setOnInsert: { world: r.world, attendance: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    s.lesson = lesson._id;
  }
  await r.save();
  const round = await InvoiceRound.findById(r.round).lean();
  const teacher = await Person.findById(r.teacher).select("firstName lastName").lean();
  const lessonIds = taught.map((s) => String(s.lesson));
  // only the sessions not yet on another invoice
  const already = new Set((await InvoiceLesson.find({ lesson: { $in: lessonIds } }).select("lesson").lean()).map((b) => String(b.lesson)));
  const fresh = lessonIds.filter((id) => !already.has(id));
  if (!fresh.length) throw AppError.of("INVOICE_LESSON_BILLED", 400);
  await invoices.createInvoice({
    world: r.world,
    teacherId: r.teacher,
    lessonIds: fresh,
    imageData,
    imageName,
    by: `${teacher?.firstName || ""} ${teacher?.lastName || ""}`.trim() || "המורה",
    note: `${monthLabel(round.month)} · דרך הקישור`,
    requestId: r._id,
  });
  return r;
}

/** The teacher takes an invoice back - only one that came through this link, while the month is open. */
async function removeInvoice(r, invoiceId) {
  assertOpen(r);
  const inv = isId(invoiceId) && (await Invoice.findOne({ _id: invoiceId, world: r.world }).select("request").lean());
  if (!inv) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  if (String(inv.request) !== String(r._id)) throw AppError.of("INVOICE_NOT_YOURS", 403);
  await invoices.deleteInvoice({ world: r.world, invoiceId });
  return r;
}

/** סיימתי - after the sessions were marked. */
async function complete(r, { note } = {}) {
  assertOpen(r);
  if (!r.sessions.some((s) => s.state)) throw AppError.of("INVOICE_DONE_EMPTY", 400);
  r.completedAt = new Date();
  if (note !== undefined) r.note = clean(note, 1000);
  await r.save();
  return r;
}

/** The picture of an invoice that came through this link. */
async function imageOf(r, invoiceId) {
  const inv = isId(invoiceId) && (await Invoice.findOne({ _id: invoiceId, world: r.world }).select("request").lean());
  if (!inv || String(inv.request) !== String(r._id)) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  return invoices.imageOf({ world: r.world, invoiceId });
}

module.exports = {
  monthLabel,
  dayKey,
  plannedSessions,
  openRound,
  listRounds,
  getRound,
  loadRound,
  loadRequest,
  markSent,
  renew,
  reopen,
  setMail,
  setNote,
  deleteRound,
  resolveToken,
  noteOpened,
  publicView,
  setSessions,
  addInvoice,
  removeInvoice,
  complete,
  imageOf,
};
