/**
 * @file invoiceRoundService - the monthly invoice round (שמרית's round,
 * 2026-10-14; Eden: "תשלחי להם קישור זמני… יהיה להם פירוט של השיעורים
 * שלהם, יוכלו לסמן איזה שיעורים, לקשר את זה לחשבונית… בדשבורד: כמה מורים
 * העלו, כמה העלו הכל, כמה חלק, כמה אפילו לא פתחו").
 *
 * The coordinator opens a month for a program (hostels first): every
 * teacher of a course live in that month gets an InvoiceRequest - a token,
 * the month's planned sessions of their courses (from the weekly slots).
 * She sends each link by WhatsApp. Behind the link the teacher sees the
 * month's lessons as the system knows them (planned from the schedule;
 * with what was reported on each) and attaches each invoice picture to
 * the lessons it covers - nothing else to mark (Eden, 2026-10-21:
 * "המורים לא אמורים לסמן איזה שיעורים התקיימו או לא בחשבוניות... רק צריכים
 * לשייך חשבוניות לשיעורים"). A billed session without a Lesson row gets
 * one - the coordinator's attendance report later lands on the same row.
 * Then סיימתי. The coordinator's page reads where everyone stands, what
 * was billed against what she reported, and closes the month with the
 * mail.
 *
 * The staff side answers through `roundView`; the teacher's side through
 * `publicView` - the teacher never sees the other teachers, the attendance
 * or the invoices' bookkeeping.
 *
 * The whole machine - the round, the request's two axes (status × link),
 * the invoice, the lesson row - with every edge case and the super
 * admin's corrections (`adminAction`) is drawn in
 * project-files/specs/hostels/invoice-state-machine.html (2026-10-22).
 * The decisions taken there are marked "decision N" below.
 * @module services/invoiceRoundService
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const InvoiceRound = require("../models/InvoiceRound");
const InvoiceRequest = require("../models/InvoiceRequest");
const Invoice = require("../models/Invoice");
const InvoiceLesson = require("../models/InvoiceLesson");
const StoredFile = require("../models/StoredFile");
const AdminAction = require("../models/AdminAction");
const Lesson = require("../models/Lesson");
const Cycle = require("../models/Cycle");
const HostelReport = require("../models/HostelReport");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const invoices = require("./invoiceService");
const { Profile } = require("../models/profiles");
const { INVOICE_ROUND_PROGRAMS, INVOICE_ROUND_PROGRAM_LABELS, INVOICE_LINK_DAYS, INVOICE_REQUEST_STATUS_LABELS, INVOICE_DUE_DAY } = require("../utils/domain");

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
async function cyclesOfMonth({ program, month }) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - DAY_MS); // a day of slack on both ends: local midnights
  const end = new Date(Date.UTC(y, m, 0) + 2 * DAY_MS);
  return Cycle.find({
    ...programCond(program),
    status: { $ne: "Cancelled" },
    teacher: { $ne: null },
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).lean();
}

/** Link the sessions that already have a lesson row (reported, or made by an earlier link). */
async function attachLessons(sessions) {
  const open = sessions.filter((s) => !s.lesson);
  if (!open.length) return;
  const cycleIds = [...new Set(open.map((s) => String(s.cycle)))];
  const dates = [...new Set(open.map((s) => s.date.toISOString()))].map((d) => new Date(d));
  const lessons = await Lesson.find({ source: "live", cycle: { $in: cycleIds }, date: { $in: dates } })
    .select("_id cycle date")
    .lean();
  const byKey = new Map(lessons.map((l) => [`${l.cycle}|${l.date.toISOString()}`, l._id]));
  for (const s of open) {
    const id = byKey.get(`${s.cycle}|${s.date.toISOString()}`);
    if (id) s.lesson = id;
  }
}

/** The month's planned sessions of every teacher of these cycles: teacher id → sessions, sorted. */
function sessionsByTeacher(cycles, month) {
  const byTeacher = new Map();
  for (const c of cycles) {
    const sessions = plannedSessions(c, month);
    if (!sessions.length) continue;
    const t = String(c.teacher);
    if (!byTeacher.has(t)) byTeacher.set(t, []);
    byTeacher.get(t).push(...sessions);
  }
  for (const sessions of byTeacher.values()) sessions.sort((a, b) => a.date - b.date || String(a.start).localeCompare(String(b.start)));
  return byTeacher;
}

const linkExpiry = () => new Date(Date.now() + INVOICE_LINK_DAYS * DAY_MS);

async function openRound({ month, program = "hostels", by }) {
  if (!MONTH_RE.test(String(month || ""))) throw AppError.of("INVOICE_ROUND_MONTH", 400);
  if (!INVOICE_ROUND_PROGRAMS.includes(program)) throw AppError.of("INVOICE_ROUND_PROGRAM", 400);
  if (await InvoiceRound.exists({ month, program })) throw AppError.of("INVOICE_ROUND_EXISTS", 409);
  const byTeacher = sessionsByTeacher(await cyclesOfMonth({ program, month }), month);
  if (!byTeacher.size) throw AppError.of("INVOICE_ROUND_NO_TEACHERS", 400);
  const expiresAt = linkExpiry();
  const requests = [];
  for (const [teacher, sessions] of byTeacher) {
    await attachLessons(sessions);
    requests.push({ teacher, token: makeToken(), expiresAt, sessions });
  }
  // the round and its requests as one unit (decision 11): a crash halfway leaves no half-opened month behind
  const roundId = await withTxn(async (session) => {
    const opts = session ? { session } : {};
    let id = null;
    try {
      const [round] = await InvoiceRound.create([{ month, program, openedBy: clean(by, 80) }], opts);
      id = round._id;
      await InvoiceRequest.insertMany(requests.map((r) => ({ ...r, round: round._id })), { ...opts, ordered: true });
      return round._id;
    } catch (e) {
      if (!session && id) {
        await InvoiceRequest.deleteMany({ round: id });
        await InvoiceRound.deleteOne({ _id: id });
      }
      throw e;
    }
  });
  return roundView(await loadRound({ roundId }));
}

/* ───────────────────────── reading ───────────────────────── */

async function loadRound({ roundId }) {
  const round = isId(roundId) && (await InvoiceRound.findOne({ _id: roundId }));
  if (!round) throw AppError.of("NOT_FOUND", 404, "סבב חשבוניות");
  return round;
}

async function loadRequest({ roundId, requestId }) {
  const r = isId(requestId) && (await InvoiceRequest.findOne({ _id: requestId, ...(roundId && { round: roundId }) }));
  if (!r) throw AppError.of("NOT_FOUND", 404, "קישור של מורה");
  return r;
}

/** Where a request stands - from the facts, never set by hand (INVOICE_REQUEST_STATUSES). */
function statusOf(r, invoiceCount) {
  if (r.completedAt) return "done";
  if (invoiceCount > 0) return "partial";
  if (r.openedAt) return "opened";
  if (r.sentAt) return "sent";
  return "new";
}

/**
 * The facts around a list of requests: their cycles (named), their
 * invoices (shaped, by request), and for every session what the system
 * knows of it - a lesson row, attendance reported on it (how many came),
 * the house's own word from its monthly draft (held / not held), and the
 * invoice it sits on.
 */
async function factsOf(requests) {
  for (const r of requests) await attachLessons(r.sessions);
  const requestIds = new Set(requests.map((r) => String(r._id)));
  const cycleIds = [...new Set(requests.flatMap((r) => r.sessions.map((s) => String(s.cycle))))];
  const lessonIds = [...new Set(requests.flatMap((r) => r.sessions.map((s) => s.lesson && String(s.lesson)).filter(Boolean)))];
  const months = [...new Set(requests.map((r) => dayKey(r.sessions[0]?.date || new Date()).slice(0, 7)))];
  const [cycles, lessons, invs, billed, drafts] = await Promise.all([
    Cycle.find({ _id: { $in: cycleIds } }).select("subject hostel schedule").populate("subject", "name").populate("hostel", "name kind").lean(),
    Lesson.find({ _id: { $in: lessonIds } }).select("_id attendance teacher").lean(),
    Invoice.find({ request: { $in: requests.map((r) => r._id) } }).sort({ uploadedAt: -1 }).lean(),
    InvoiceLesson.find({ lesson: { $in: lessonIds } }).select("lesson invoice").lean(),
    cycleIds.length ? HostelReport.find({ month: { $in: months }, "sessions.cycle": { $in: cycleIds } }).select("sessions.cycle sessions.date sessions.state").lean() : [],
  ]);
  // an invoice that sits on the month's lessons without having come through a link - uploaded from the teacher's
  // file, or before the month opened - is the request's too (decision 7); a substitute's invoice is not
  const byLink = new Set(invs.map((i) => String(i._id)));
  const extraIds = [...new Set(billed.map((b) => String(b.invoice)).filter((id) => !byLink.has(id)))];
  const extra = extraIds.length ? await Invoice.find({ _id: { $in: extraIds } }).lean() : [];
  const shaped = await invoices.shape([...invs, ...extra]);
  const requestOfLesson = new Map();
  const teacherOfRequest = new Map(requests.map((r) => [String(r._id), String(r.teacher)]));
  for (const r of requests) for (const s of r.sessions) if (s.lesson) requestOfLesson.set(String(s.lesson), String(r._id));
  const invoicesByRequest = new Map();
  const put = (k, i) => {
    if (!invoicesByRequest.has(k)) invoicesByRequest.set(k, []);
    const list = invoicesByRequest.get(k);
    if (!list.some((x) => String(x._id) === String(i._id))) list.push(i);
  };
  for (const i of shaped) {
    if (i.request && requestIds.has(String(i.request))) put(String(i.request), i);
    else for (const l of i.lessons) {
      const k = requestOfLesson.get(String(l._id));
      if (k && teacherOfRequest.get(k) === String(i.teacher)) put(k, i);
    }
  }
  for (const list of invoicesByRequest.values()) list.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  // a lesson a substitute taught (decision 6): the session is theirs, not the request's teacher's
  const lessonTeacher = new Map(lessons.filter((l) => l.teacher).map((l) => [String(l._id), String(l.teacher)]));
  const subIds = [...new Set(lessonTeacher.values())];
  const subs = subIds.length ? await Person.find({ _id: { $in: subIds } }).select("firstName lastName").lean() : [];
  const subById = new Map(subs.map((p) => [String(p._id), `${p.firstName || ""} ${p.lastName || ""}`.trim()]));
  const houseSaid = new Map();
  for (const d of drafts) for (const s of d.sessions || []) if (s.state) houseSaid.set(`${s.cycle}|${new Date(s.date).toISOString()}`, s.state);
  return {
    cycleById: new Map(cycles.map((c) => [String(c._id), c])),
    reported: new Set(lessons.filter((l) => (l.attendance || []).length > 0).map((l) => String(l._id))),
    presentByLesson: new Map(lessons.map((l) => [String(l._id), (l.attendance || []).filter((a) => a.status === "Present").length])),
    houseSaid,
    invoicesByRequest,
    invoiceByLesson: new Map(billed.map((b) => [String(b.lesson), String(b.invoice)])),
    substituteOf: (lessonId, teacherId) => {
      const t = lessonTeacher.get(lessonId);
      return t && t !== String(teacherId) ? { _id: t, name: subById.get(t) || "מורה אחר/ת" } : null;
    },
  };
}

const cycleView = (c) => (c ? { _id: c._id, subject: c.subject ? { _id: c.subject._id, name: c.subject.name } : null, hostel: c.hostel ? { _id: c.hostel._id, name: c.hostel.name, kind: c.hostel.kind } : null } : null);
const cycleName = (c) => (c ? `${c.subject?.name || "קורס"}${c.hostel ? ` · ${c.hostel.kind === "community" ? "קהילת" : "הוסטל"} ${c.hostel.name}` : ""}` : "קורס");

/** A session as the system knows it: reported (how many came), the house's word, the invoice it sits on, who taught it if not the teacher. */
function sessionView(s, facts, teacherId) {
  const lesson = s.lesson ? String(s.lesson) : null;
  const reported = !!(lesson && facts.reported.has(lesson));
  return {
    _id: s._id,
    cycle: cycleView(facts.cycleById.get(String(s.cycle))),
    date: s.date,
    start: s.start,
    end: s.end,
    lesson,
    reported,
    present: reported ? facts.presentByLesson.get(lesson) || 0 : null,
    houseSaid: facts.houseSaid.get(`${s.cycle}|${new Date(s.date).toISOString()}`) || null,
    invoice: lesson ? facts.invoiceByLesson.get(lesson) || null : null,
    substitute: lesson ? facts.substituteOf(lesson, teacherId) : null,
  };
}

/**
 * billed = on an invoice; reported = attendance on it; billedNotReported /
 * reportedNotBilled = what the coordinator checks ("לבדוק" - never resolved
 * by the machine); houseNotHeld = the house's draft said it did not take
 * place; substituted = someone else taught it (not this teacher's to bill,
 * counted apart).
 */
function countsOf(sessions) {
  const c = { sessions: sessions.length, billed: 0, unbilled: 0, reported: 0, billedNotReported: 0, reportedNotBilled: 0, houseNotHeld: 0, substituted: 0 };
  for (const s of sessions) {
    if (s.substitute) {
      c.substituted++;
      continue;
    }
    if (s.invoice) c.billed++;
    else c.unbilled++;
    if (s.reported) c.reported++;
    if (s.invoice && !s.reported) c.billedNotReported++;
    if (s.reported && !s.invoice) c.reportedNotBilled++;
    if (s.houseSaid === "notHeld") c.houseNotHeld++;
  }
  return c;
}

function requestView(r, facts, teacher, rate = null) {
  const invs = facts.invoicesByRequest.get(String(r._id)) || [];
  const sessions = r.sessions.map((s) => sessionView(s, facts, r.teacher));
  const status = statusOf(r, invs.length);
  return {
    _id: r._id,
    round: r.round,
    // `rate` = ₪ per session in the hostels (the Teacher profile) - the page checks the invoice's sum against billed × rate
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
  const facts = await factsOf(requests);
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
    counts.mismatches += r.counts.billedNotReported + r.counts.reportedNotBilled;
  }
  return {
    _id: round._id,
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
async function listRounds({ programs = null }) {
  const filter = {};
  if (programs) filter.program = { $in: programs };
  const rounds = await InvoiceRound.find(filter).sort({ month: -1, program: 1 });
  const out = [];
  for (const r of rounds) out.push(await roundView(r));
  return out;
}

async function getRound({ roundId }) {
  return roundView(await loadRound({ roundId }));
}

/* ───────────────────────── the coordinator's moves ───────────────────────── */

/** She sent the link (by WhatsApp, outside the app) - noted with her name. */
async function markSent({ roundId, requestId, by }) {
  const r = await loadRequest({ roundId, requestId });
  r.sentAt = new Date();
  r.sentBy = clean(by, 80);
  await r.save();
  return getRound({ roundId });
}

/** The link open again for `days` from now (the same address - a message already sent keeps working). */
async function renew({ roundId, requestId, days }) {
  const r = await loadRequest({ roundId, requestId });
  const n = Number(days) > 0 ? Math.min(Number(days), 90) : INVOICE_LINK_DAYS;
  r.expiresAt = new Date(Date.now() + n * DAY_MS);
  await r.save();
  return getRound({ roundId });
}

/** The teacher pressed סיימתי too soon - the coordinator opens it back. */
async function reopen({ roundId, requestId }) {
  const r = await loadRequest({ roundId, requestId });
  r.completedAt = undefined;
  await r.save();
  return getRound({ roundId });
}

/**
 * The mail with the PDFs went to the bookkeeping (or did not, after all).
 * The mail closes the teachers' links (decision 2: what went out stays what
 * it is); taking the mail back opens them for another three weeks.
 */
async function setMail({ roundId, sent, by }) {
  const round = await loadRound({ roundId });
  round.mail = sent ? { sentAt: new Date(), sentBy: clean(by, 80) } : {};
  await round.save();
  await InvoiceRequest.updateMany({ round: round._id }, { $set: { expiresAt: sent ? new Date() : linkExpiry() } });
  return roundView(round);
}

/**
 * Rule 4 of the state machine: a request never stays "הושלם" with nothing
 * in it. After an invoice of a link went (the staff's delete), a finished
 * request with no invoice and no note opens again. Answers whether it did.
 */
async function settleAfterDelete({ requestId }) {
  const r = isId(requestId) && (await InvoiceRequest.findOne({ _id: requestId }));
  if (!r || !r.completedAt || r.note) return false;
  if (await Invoice.exists({ request: r._id })) return false;
  r.completedAt = undefined;
  await r.save();
  return true;
}

async function setNote({ roundId, note }) {
  const round = await loadRound({ roundId });
  round.note = clean(note, 1000);
  await round.save();
  return roundView(round);
}

/** A round opened by mistake: gone with its requests - unless an invoice came through one of them. */
async function deleteRound({ roundId }) {
  const round = await loadRound({ roundId });
  const requests = await InvoiceRequest.find({ round: round._id }).select("_id").lean();
  if (await Invoice.exists({ request: { $in: requests.map((r) => r._id) } })) throw AppError.of("INVOICE_ROUND_HAS_INVOICES", 409);
  await InvoiceRequest.deleteMany({ round: round._id });
  await InvoiceRound.deleteOne({ _id: round._id });
}

/* ───────────────────────── the teacher's side (behind the link) ───────────────────────── */

/** The request behind a token; an expired link answers 410 - unless `readWhenDone` and the teacher finished (decision 12: the summary stays readable). */
async function resolveToken({ token, readWhenDone = false }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("INVOICE_LINK_INVALID", 404);
  const r = await InvoiceRequest.findOne({ token: t });
  if (!r) throw AppError.of("INVOICE_LINK_INVALID", 404);
  if (!r.linkLive() && !(readWhenDone && r.completedAt)) throw AppError.of("INVOICE_LINK_EXPIRED", 410);
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
  const facts = await factsOf([r]);
  const sessions = r.sessions.map((s) => sessionView(s, facts, r.teacher));
  const groups = new Map();
  for (const s of sessions) {
    const k = String(s.cycle?._id || "");
    if (!groups.has(k)) groups.set(k, { cycle: s.cycle, name: cycleName(facts.cycleById.get(k)), sessions: [] });
    groups.get(k).sessions.push({ _id: s._id, date: s.date, start: s.start, end: s.end, reported: s.reported, present: s.present, houseSaid: s.houseSaid, invoice: s.invoice, substitute: s.substitute });
  }
  const invs = (facts.invoicesByRequest.get(String(r._id)) || []).map((i) => ({
    _id: i._id,
    uploadedAt: i.uploadedAt,
    file: i.file ? { name: i.file.name, mime: i.file.mime, size: i.file.size, thumb: !!i.file.thumb } : null,
    lessons: i.lessons.map((l) => ({ _id: l._id, date: l.date, name: cycleName(facts.cycleById.get(String(l.cycle))) })),
    // uploaded from the teacher's file by the staff (decision 7): shown, never the teacher's to take back
    fromFile: !i.request,
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
    linkLive: r.linkLive(),
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

/**
 * The invoice picture, attached to the sessions it covers - the teacher's
 * only move. A covered session without a lesson row gets one now (the
 * same row the coordinator's report will fill); one already on another
 * invoice is refused.
 */
/** A session that remembers a lesson row that is gone (deleted since) forgets it - case 19 of the state machine; answers how many. */
async function healLessons(sessions) {
  const ids = sessions.map((s) => s.lesson).filter(Boolean);
  if (!ids.length) return 0;
  const alive = new Set((await Lesson.find({ _id: { $in: ids } }).select("_id").lean()).map((l) => String(l._id)));
  let n = 0;
  for (const s of sessions) {
    if (!s.lesson || alive.has(String(s.lesson))) continue;
    s.lesson = null;
    n++;
  }
  return n;
}

async function addInvoice(r, { imageData, imageName, thumb, stored = null, sessionIds }) {
  assertOpen(r);
  const wanted = Array.isArray(sessionIds) ? new Set(sessionIds.map(String)) : new Set();
  if (!wanted.size) throw AppError.of("INVOICE_NO_SESSIONS", 400);
  const covered = r.sessions.filter((s) => wanted.has(String(s._id)));
  if (covered.length !== wanted.size) throw AppError.of("INVOICE_SESSION_UNKNOWN", 400);
  await healLessons(covered);
  await attachLessons(covered);
  // a session someone else taught (the substitute written on its lesson) is theirs to bill, from their file (decision 6)
  const subbed = await Lesson.exists({ _id: { $in: covered.map((s) => s.lesson).filter(Boolean) }, teacher: { $nin: [null, r.teacher] } });
  if (subbed) throw AppError.of("INVOICE_SESSION_SUBSTITUTE", 400);
  for (const s of covered) {
    if (s.lesson) continue;
    const lesson = await Lesson.findOneAndUpdate(
      { cycle: s.cycle, date: s.date, source: "live" },
      { $setOnInsert: { attendance: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    s.lesson = lesson._id;
  }
  await r.save();
  const round = await InvoiceRound.findById(r.round).lean();
  const teacher = await Person.findById(r.teacher).select("firstName lastName").lean();
  const lessonIds = covered.map((s) => String(s.lesson));
  // a session sits on one invoice only
  const already = await InvoiceLesson.exists({ lesson: { $in: lessonIds } });
  if (already) throw AppError.of("INVOICE_LESSON_BILLED", 400);
  await invoices.createInvoice({
    teacherId: r.teacher,
    lessonIds,
    imageData,
    imageName,
    thumb,
    stored,
    by: `${teacher?.firstName || ""} ${teacher?.lastName || ""}`.trim() || "המורה",
    note: `${monthLabel(round.month)} · דרך הקישור`,
    requestId: r._id,
  });
  return r;
}

/** The teacher takes an invoice back - only one that came through this link, while the month is open. */
async function removeInvoice(r, invoiceId) {
  assertOpen(r);
  const inv = isId(invoiceId) && (await Invoice.findOne({ _id: invoiceId }).select("request").lean());
  if (!inv) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  if (String(inv.request) !== String(r._id)) throw AppError.of("INVOICE_NOT_YOURS", 403);
  await invoices.deleteInvoice({ invoiceId });
  return r;
}

/** סיימתי - with an invoice in, or a word on why there is none. */
async function complete(r, { note } = {}) {
  assertOpen(r);
  const text = note !== undefined ? clean(note, 1000) : r.note;
  if (!text && !(await Invoice.exists({ request: r._id }))) throw AppError.of("INVOICE_DONE_EMPTY", 400);
  r.completedAt = new Date();
  if (note !== undefined) r.note = text;
  await r.save();
  return r;
}

/** An invoice this request may show: one that came through the link, or the teacher's own on the month's lessons → { _id, file, teacher, request }. */
async function invoiceOfRequest(r, invoiceId) {
  const inv = isId(invoiceId) && (await Invoice.findOne({ _id: invoiceId }).select("request teacher file").lean());
  if (!inv) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  await attachLessons(r.sessions); // the month's lesson rows the request has not noted yet (never saved here)
  const mine =
    String(inv.request) === String(r._id) ||
    (String(inv.teacher) === String(r.teacher) && (await InvoiceLesson.exists({ invoice: inv._id, lesson: { $in: r.sessions.map((s) => s.lesson).filter(Boolean) } })));
  if (!mine) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  return inv;
}

/* ───────────────────────── the super admin's corrections (the state machine, section 08) ─────────────────────────
 * Every action rewrites facts and the status follows from them as always. Five rules each one keeps:
 *   1. an invoice goes as a unit (its rows, its file) - invoiceService.deleteInvoice;
 *   2. a lesson row goes only when nothing rests on it (dropBareLessons);
 *   3. a cached pointer to a lesson row that went is cleared (clearDeadLessonPointers);
 *   4. a request never stays "הושלם" with nothing in it (settleAfterDelete);
 *   5. every action says what it did, in numbers, and leaves a line in `adminActions`. */

/** Rule 3: `sessions[].lesson` naming a lesson row that is gone → null, on every request and the houses' drafts. */
async function clearDeadLessonPointers(lessonIds) {
  const ids = lessonIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return 0;
  const [a, b] = await Promise.all([
    InvoiceRequest.updateMany({ "sessions.lesson": { $in: ids } }, { $set: { "sessions.$[s].lesson": null } }, { arrayFilters: [{ "s.lesson": { $in: ids } }] }),
    HostelReport.updateMany({ "sessions.lesson": { $in: ids } }, { $set: { "sessions.$[s].lesson": null } }, { arrayFilters: [{ "s.lesson": { $in: ids } }] }),
  ]);
  return (a.modifiedCount || 0) + (b.modifiedCount || 0);
}

/**
 * Rule 2: of these lesson rows (the ones a link made, as far as the request remembers), the bare ones go - no
 * attendance, no substitute or room written on them, no invoice row left, no house draft pointing at them. The
 * rest are the attendance's now and stay. Answers how many went.
 */
async function dropBareLessons(lessonIds) {
  const ids = [...new Set(lessonIds.filter(Boolean).map(String))];
  if (!ids.length) return 0;
  const [stillBilled, inDrafts] = await Promise.all([
    InvoiceLesson.find({ lesson: { $in: ids } }).select("lesson").lean(),
    HostelReport.find({ "sessions.lesson": { $in: ids } }).select("sessions.lesson").lean(),
  ]);
  const keep = new Set(stillBilled.map((b) => String(b.lesson)));
  for (const d of inDrafts) for (const s of d.sessions || []) if (s.lesson) keep.add(String(s.lesson));
  const free = ids.filter((id) => !keep.has(id));
  if (!free.length) return 0;
  const bare = await Lesson.find({ _id: { $in: free }, source: "live", attendance: { $size: 0 }, teacher: null, room: null }).select("_id").lean();
  if (!bare.length) return 0;
  const gone = bare.map((l) => l._id);
  await Lesson.deleteMany({ _id: { $in: gone } });
  await clearDeadLessonPointers(gone);
  return gone.length;
}

/** Rule 1 on every invoice that came through one link: answers { invoices, rows } (one file per invoice). */
async function deleteInvoicesOf(requestId) {
  const invs = await Invoice.find({ request: requestId }).select("_id").lean();
  if (!invs.length) return { invoices: 0, rows: 0 };
  const rows = await InvoiceLesson.countDocuments({ invoice: { $in: invs.map((i) => i._id) } });
  for (const i of invs) await invoices.deleteInvoice({ invoiceId: i._id });
  return { invoices: invs.length, rows };
}

/** B: the teacher's link as if nothing happened - the invoices gone, the finish and the opening forgotten, three weeks open again; the token kept or rotated (decision 3). */
async function resetRequest(r, { rotateToken = false } = {}) {
  const gone = await deleteInvoicesOf(r._id);
  r.completedAt = undefined;
  r.note = undefined;
  r.openedAt = undefined;
  r.lastOpenedAt = undefined;
  r.expiresAt = linkExpiry();
  if (rotateToken) r.token = makeToken();
  await r.save();
  return gone;
}

/** D: the month's sessions from the live schedule again; a session already on an invoice stays as it is, even off the schedule (same cycle and day = same lesson row). */
async function rebuildSessions(r) {
  const round = await InvoiceRound.findById(r.round).lean();
  const cycles = (await cyclesOfMonth({ program: round.program, month: round.month })).filter((c) => String(c.teacher) === String(r.teacher));
  const fresh = cycles.flatMap((c) => plannedSessions(c, round.month));
  await attachLessons(fresh);
  const billed = new Set((await InvoiceLesson.find({ lesson: { $in: r.sessions.map((s) => s.lesson).filter(Boolean) } }).select("lesson").lean()).map((b) => String(b.lesson)));
  const keyOf = (s) => `${s.cycle}|${new Date(s.date).toISOString()}`;
  const kept = r.sessions.filter((s) => s.lesson && billed.has(String(s.lesson))).map((s) => s.toObject());
  const keptKeys = new Set(kept.map(keyOf));
  const next = [...kept, ...fresh.filter((s) => !keptKeys.has(keyOf(s)))].sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.start).localeCompare(String(b.start)));
  r.sessions = next;
  await r.save();
  return { kept: kept.length, sessions: next.length };
}

/** E: a request for every teacher of the month who has none yet (a course or a teacher that came after the opening). Answers how many. */
async function syncRequests(round) {
  const byTeacher = sessionsByTeacher(await cyclesOfMonth({ program: round.program, month: round.month }), round.month);
  const have = new Set((await InvoiceRequest.find({ round: round._id }).select("teacher").lean()).map((r) => String(r.teacher)));
  const expiresAt = linkExpiry();
  let n = 0;
  for (const [teacher, sessions] of byTeacher) {
    if (have.has(teacher)) continue;
    await attachLessons(sessions);
    await InvoiceRequest.create({ round: round._id, teacher, token: makeToken(), expiresAt, sessions });
    n++;
  }
  return n;
}

/**
 * H: what points at nothing, anywhere. Invoice rows without their invoice or their lesson, pointers to
 * lesson rows that are gone, invoices without their file or without a single row. With `dryRun` it only counts;
 * otherwise the rows and the pointers are fixed, and the invoices are listed for the super admin to delete on purpose.
 */
async function orphanSweep({ dryRun }) {
  const rows = await InvoiceLesson.find().select("invoice lesson").lean();
  const [invs, lessons] = await Promise.all([
    Invoice.find().select("_id file teacher uploadedAt request").lean(),
    Lesson.find({ _id: { $in: [...new Set(rows.map((r) => String(r.lesson)))] } }).select("_id").lean(),
  ]);
  const invSet = new Set(invs.map((i) => String(i._id)));
  const lessonSet = new Set(lessons.map((l) => String(l._id)));
  const rowsWithoutInvoice = rows.filter((r) => !invSet.has(String(r.invoice)));
  const rowsWithoutLesson = rows.filter((r) => invSet.has(String(r.invoice)) && !lessonSet.has(String(r.lesson)));
  // ($ne: null on an array path would skip a request whose OTHER sessions have no lesson yet)
  const [reqs, drafts] = await Promise.all([
    InvoiceRequest.find({ "sessions.lesson": { $type: "objectId" } }).select("sessions.lesson").lean(),
    HostelReport.find({ "sessions.lesson": { $type: "objectId" } }).select("sessions.lesson").lean(),
  ]);
  const pointed = [...reqs, ...drafts].flatMap((d) => (d.sessions || []).map((s) => s.lesson && String(s.lesson)).filter(Boolean));
  const pointedIds = [...new Set(pointed)];
  const alive = new Set((await Lesson.find({ _id: { $in: pointedIds } }).select("_id").lean()).map((l) => String(l._id)));
  const deadIds = pointedIds.filter((id) => !alive.has(id));
  const dead = new Set(deadIds);
  const files = new Set((await StoredFile.find({ _id: { $in: invs.map((i) => i.file) } }).select("_id").lean()).map((f) => String(f._id)));
  // an invoice counts as "without lessons" once its orphan rows are gone - the same answer before and after the fix
  const withRows = new Set(rows.filter((r) => invSet.has(String(r.invoice)) && lessonSet.has(String(r.lesson))).map((r) => String(r.invoice)));
  const brief = (i) => ({ _id: i._id, teacher: i.teacher, uploadedAt: i.uploadedAt, viaLink: !!i.request });
  const report = {
    rowsWithoutInvoice: rowsWithoutInvoice.length,
    rowsWithoutLesson: rowsWithoutLesson.length,
    deadPointers: pointed.filter((id) => dead.has(id)).length,
    invoicesWithoutFile: invs.filter((i) => !files.has(String(i.file))).map(brief),
    invoicesWithoutLessons: invs.filter((i) => !withRows.has(String(i._id))).map(brief),
    fixed: false,
  };
  if (!dryRun) {
    const goneRows = [...rowsWithoutInvoice, ...rowsWithoutLesson].map((r) => r._id);
    if (goneRows.length) await InvoiceLesson.deleteMany({ _id: { $in: goneRows } });
    if (deadIds.length) await clearDeadLessonPointers(deadIds);
    report.fixed = true;
  }
  return report;
}

const teacherLabel = async (id) => {
  const t = await Person.findById(id).select("firstName lastName").lean();
  return t ? `${t.firstName || ""} ${t.lastName || ""}`.trim() : String(id);
};

/**
 * POST /api/invoice-rounds/:id/admin - `{ action, invoice?, request?, rotateToken?, force?, dryRun? }`, the super
 * admin as himself. Answers `{ round, did }` - the round as it stands now (null once deleted) and what happened in
 * numbers - and writes the line in `adminActions`.
 *   invoiceDelete   { invoice }                 A: one invoice of the round, in any state
 *   requestReset    { request, rotateToken }    B
 *   requestRemove   { request, force }          C: 409 INVOICE_REQUEST_HAS_INVOICES without force when invoices came through it
 *   sessionsRebuild { request }                 D
 *   requestsSync                                E
 *   roundReset      { rotateToken }             F
 *   roundDelete     { force }                   G: with force the invoices go too; without, today's delete (409 with invoices)
 *   orphanSweep     { dryRun }                  H: the orphans counted (dryRun) or fixed
 */
async function adminAction(round, { action, invoice, request, rotateToken, force, dryRun } = {}, actor) {
  const did = { invoices: 0, files: 0, invoiceLessons: 0, lessons: 0, requests: 0, reopened: 0 };
  const targets = [{ kind: "round", id: String(round._id), label: `${monthLabel(round.month)} · ${INVOICE_ROUND_PROGRAM_LABELS[round.program]}` }];
  const took = (gone) => {
    did.invoices += gone.invoices;
    did.files += gone.invoices;
    did.invoiceLessons += gone.rows;
  };
  let alive = true;
  switch (action) {
    case "invoiceDelete": {
      const inv = isId(invoice) && (await Invoice.findOne({ _id: invoice }).select("request teacher").lean());
      if (!inv) throw AppError.of("NOT_FOUND", 404, "חשבונית");
      // of this round: through one of its links, or on one of its lessons
      const reqs = await InvoiceRequest.find({ round: round._id }).select("_id sessions.lesson").lean();
      const lessonIds = reqs.flatMap((r) => r.sessions.map((s) => s.lesson).filter(Boolean));
      const ofRound = reqs.some((r) => String(r._id) === String(inv.request)) || (await InvoiceLesson.exists({ invoice: inv._id, lesson: { $in: lessonIds } }));
      if (!ofRound) throw AppError.of("NOT_FOUND", 404, "חשבונית");
      did.invoiceLessons = await InvoiceLesson.countDocuments({ invoice: inv._id });
      await invoices.deleteInvoice({ invoiceId: inv._id });
      did.invoices = 1;
      did.files = 1;
      if (inv.request && (await settleAfterDelete({ requestId: inv.request }))) did.reopened = 1;
      targets.push({ kind: "invoice", id: String(inv._id), label: await teacherLabel(inv.teacher) });
      break;
    }
    case "requestReset": {
      const r = await loadRequest({ roundId: round._id, requestId: request });
      took(await resetRequest(r, { rotateToken: !!rotateToken }));
      did.requests = 1;
      targets.push({ kind: "request", id: String(r._id), label: await teacherLabel(r.teacher) });
      break;
    }
    case "requestRemove": {
      const r = await loadRequest({ roundId: round._id, requestId: request });
      if (!force && (await Invoice.exists({ request: r._id }))) throw AppError.of("INVOICE_REQUEST_HAS_INVOICES", 409);
      took(await deleteInvoicesOf(r._id));
      const lessonIds = r.sessions.map((s) => s.lesson).filter(Boolean);
      await InvoiceRequest.deleteOne({ _id: r._id });
      did.requests = 1;
      did.lessons = await dropBareLessons(lessonIds);
      targets.push({ kind: "request", id: String(r._id), label: await teacherLabel(r.teacher) });
      break;
    }
    case "sessionsRebuild": {
      const r = await loadRequest({ roundId: round._id, requestId: request });
      Object.assign(did, await rebuildSessions(r));
      targets.push({ kind: "request", id: String(r._id), label: await teacherLabel(r.teacher) });
      break;
    }
    case "requestsSync":
      did.requests = await syncRequests(round);
      break;
    case "roundReset": {
      for (const r of await InvoiceRequest.find({ round: round._id })) {
        took(await resetRequest(r, { rotateToken: !!rotateToken }));
        did.requests++;
      }
      round.mail = {};
      await round.save();
      break;
    }
    case "roundDelete": {
      if (!force) {
        did.requests = await InvoiceRequest.countDocuments({ round: round._id });
        await deleteRound({ roundId: round._id });
      } else {
        const reqs = await InvoiceRequest.find({ round: round._id }).select("_id sessions.lesson").lean();
        for (const r of reqs) took(await deleteInvoicesOf(r._id));
        did.requests = (await InvoiceRequest.deleteMany({ round: round._id })).deletedCount || 0;
        await InvoiceRound.deleteOne({ _id: round._id });
        did.lessons = await dropBareLessons(reqs.flatMap((r) => r.sessions.map((s) => s.lesson).filter(Boolean)));
      }
      alive = false;
      break;
    }
    case "orphanSweep":
      did.sweep = await orphanSweep({ dryRun: !!dryRun });
      break;
    default:
      throw AppError.of("INVOICE_ADMIN_ACTION", 400, String(action || ""));
  }
  await AdminAction.create({ actor: { id: actor?._id || null, name: actor?.name || "", kind: actor?.kind || "" }, family: "invoices", action, targets, did });
  return { round: alive ? await roundView(await loadRound({ roundId: round._id })) : null, did };
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
  settleAfterDelete,
  resolveToken,
  noteOpened,
  publicView,
  addInvoice,
  removeInvoice,
  invoiceOfRequest,
  complete,
  adminAction,
  orphanSweep,
};
