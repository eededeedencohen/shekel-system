/**
 * @file hostelReportService - the hostel's attendance DRAFT for a month
 * (phase 3 of שמרית's round; her talk of 2026-10-14: the house's contact
 * reports who came, a new resident, who left - "לפעמים עדיף להשאיר שטחים
 * אפורים" - and her approval is the report).
 *
 * The coordinator opens a month: every active house with a course live in
 * it gets a HostelReport - a token, the month's planned sessions of its
 * courses (from the weekly slots), the house's reporter as the addressee.
 * She sends each link by WhatsApp. Behind the link the contact marks a
 * session once its day came: held / not held, who came, why someone did
 * not (ABSENCE_REASONS - what keeps a false report from the Ministry of
 * Health), someone not on the list, someone who left. Nothing of it is
 * attendance yet: the coordinator approves a session (the marks become the
 * Lesson's attendance, reasons included), adds the new resident, closes
 * the leaver's residence - each a move of hers.
 *
 * The Ministry's monthly report (her file of 2026-10-19) reads from the
 * same houses: the hostels alone (never a קהילה), each course's average
 * attendance in the month, the approvals and the activity start.
 * @module services/hostelReportService
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const HostelReport = require("../models/HostelReport");
const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const Lesson = require("../models/Lesson");
const Enrollment = require("../models/Enrollment");
const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");
const AppError = require("../utils/AppError");
const tags = require("./tagService");
const { monthLabel, dayKey, plannedSessions } = require("./invoiceRoundService");
const { ABSENCE_REASONS, ABSENCE_REASON_KEYS, HOSTEL_REPORT_LINK_DAYS, HOSTEL_REPORT_SESSION_STATES, HOSTEL_REPORT_MARKS, HOSTEL_REPORT_STATUS_LABELS, OCCUPYING_STATUSES } = require("../utils/domain");

const DAY_MS = 24 * 3600 * 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isId = (v) => mongoose.isValidObjectId(v);
const makeToken = () => crypto.randomBytes(18).toString("base64url");
const clean = (s, max = 200) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);
const REASON_LABEL = Object.fromEntries(ABSENCE_REASONS.map((r) => [r.key, r.label]));
/** Today in Israel, "YYYY-MM-DD" - a session is marked on its day or after it, never before. */
const todayKey = () => dayKey(new Date());
const personName = (p) => (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "");
const hostelTitle = (h) => (h ? `${h.kind === "community" ? "קהילת" : "הוסטל"} ${h.name}` : "");

/* ───────────────────────── opening a month ───────────────────────── */

/** The house's reporter: the one who reports, else the manager, else anyone, else the old single contact. */
function reporterOf(h) {
  const list = Array.isArray(h.contacts) ? h.contacts : [];
  const c = list.find((x) => x.role === "reporter") || list.find((x) => x.role === "manager") || list[0] || (h.contact?.name ? h.contact : null);
  return c ? { name: c.name || "", phone: c.phone || "" } : { name: "", phone: "" };
}

/** The live cycles of the house in the month (status ≠ Cancelled, dates overlapping, a day of slack for local midnights). */
async function cyclesOfMonth({ world, hostelId, month }) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - DAY_MS);
  const end = new Date(Date.UTC(y, m, 0) + 2 * DAY_MS);
  return Cycle.find({ world, hostel: hostelId, status: { $ne: "Cancelled" }, startDate: { $lte: end }, endDate: { $gte: start } }).lean();
}

/** The link lives through the month and HOSTEL_REPORT_LINK_DAYS after it - and never less than that from today. */
function expiryOf(month) {
  const [y, m] = month.split("-").map(Number);
  const afterMonth = new Date(Date.UTC(y, m, 0) + (HOSTEL_REPORT_LINK_DAYS + 1) * DAY_MS);
  const fromNow = new Date(Date.now() + HOSTEL_REPORT_LINK_DAYS * DAY_MS);
  return afterMonth > fromNow ? afterMonth : fromNow;
}

/**
 * Open the month for every active house (or for one): a report per house
 * with a course live in it. Houses already opened, or without a course,
 * are skipped - unless one house was asked for, then it is an error.
 */
async function openMonth({ world, month, hostelId = null, by }) {
  if (!MONTH_RE.test(String(month || ""))) throw AppError.of("HOSTEL_REPORT_MONTH", 400);
  let hostels;
  if (hostelId) {
    const h = isId(hostelId) && (await Hostel.findOne({ _id: hostelId, world }).lean());
    if (!h) throw AppError.of("NOT_FOUND", 404, "הוסטל");
    hostels = [h];
  } else hostels = await Hostel.find({ world, active: { $ne: false } }).sort({ name: 1 }).lean();
  const one = !!hostelId;
  const created = [];
  for (const h of hostels) {
    if (await HostelReport.exists({ world, hostel: h._id, month })) {
      if (one) throw AppError.of("HOSTEL_REPORT_EXISTS", 409);
      continue;
    }
    const cycles = await cyclesOfMonth({ world, hostelId: h._id, month });
    const sessions = cycles.flatMap((c) => plannedSessions(c, month)).map((s) => ({ ...s, state: null, marks: [] }));
    if (!sessions.length) {
      if (one) throw AppError.of("HOSTEL_REPORT_NO_COURSES", 400);
      continue;
    }
    sessions.sort((a, b) => a.date - b.date || String(a.start).localeCompare(String(b.start)));
    created.push(await HostelReport.create({ world, hostel: h._id, month, token: makeToken(), expiresAt: expiryOf(month), contact: reporterOf(h), openedBy: clean(by, 80), sessions }));
  }
  if (!created.length) throw AppError.of("HOSTEL_REPORT_NO_COURSES", 400);
  return viewsOf(world, created);
}

/**
 * The draft follows the house's courses. A course added to the house, a
 * time moved or a course ended after the month was opened changes the
 * planned sessions: the missing ones are added, an unmarked one that no
 * longer stands is dropped, a session the house already spoke about stays
 * as it is (its word is kept and the coordinator sees it). Runs on every
 * read while the link lives and the house has not pressed סיימתי; after
 * that the draft is frozen as it was handed in.
 */
async function syncSessions(r) {
  if (r.completedAt || !r.linkLive()) return r;
  const cycles = await cyclesOfMonth({ world: r.world, hostelId: r.hostel, month: r.month });
  const wanted = cycles.flatMap((c) => plannedSessions(c, r.month));
  const keyOf = (s) => `${s.cycle}|${new Date(s.date).toISOString()}|${s.start}`;
  const have = new Map(r.sessions.map((s) => [keyOf(s), s]));
  const want = new Map(wanted.map((s) => [keyOf(s), s]));
  let changed = false;
  const next = [];
  for (const s of r.sessions) {
    const w = want.get(keyOf(s));
    if (!w && !s.state && !s.approvedAt) {
      changed = true;
      continue;
    }
    if (w && !s.state && !s.approvedAt && s.end !== w.end) {
      s.end = w.end;
      changed = true;
    }
    next.push(s.toObject());
  }
  for (const [k, w] of want) if (!have.has(k)) {
    next.push({ ...w, state: null, marks: [] });
    changed = true;
  }
  if (!changed) return r;
  next.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.start).localeCompare(String(b.start)));
  r.sessions = next;
  await r.save();
  return r;
}

/* ───────────────────────── reading ───────────────────────── */

async function loadReport({ world, reportId }) {
  const r = isId(reportId) && (await HostelReport.findOne({ _id: reportId, world }));
  if (!r) throw AppError.of("NOT_FOUND", 404, "דיווח של הוסטל");
  return r;
}

/** The people seated in these cycles now: cycleId → [{ _id, firstName, lastName, gender }], by name. */
async function rostersOf(world, cycleIds) {
  const seats = await Enrollment.find({ world, cycle: { $in: cycleIds }, status: { $in: OCCUPYING_STATUSES } }).select("cycle student").lean();
  const people = await Person.find({ _id: { $in: [...new Set(seats.map((s) => String(s.student)))] }, deletedAt: null }).select("firstName lastName gender").lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const out = new Map();
  for (const s of seats) {
    const p = byId.get(String(s.student));
    if (!p) continue;
    const k = String(s.cycle);
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).some((x) => String(x._id) === String(p._id))) out.get(k).push(p);
  }
  for (const list of out.values()) list.sort((a, b) => personName(a).localeCompare(personName(b), "he"));
  return out;
}

/**
 * The facts around reports: their houses, their cycles (named, with the
 * teacher), whether a lesson with attendance already sits on a session's
 * day (reported elsewhere), and the names behind every person id.
 */
async function factsOf(world, reports) {
  const hostelIds = [...new Set(reports.map((r) => String(r.hostel)))];
  const cycleIds = [...new Set(reports.flatMap((r) => [...r.sessions.map((s) => String(s.cycle)), ...r.extras.map((x) => x.cycle && String(x.cycle)).filter(Boolean)]))];
  const dates = [...new Set(reports.flatMap((r) => r.sessions.map((s) => new Date(s.date).toISOString())))].map((d) => new Date(d));
  const personIds = [...new Set(reports.flatMap((r) => [...r.sessions.flatMap((s) => s.marks.map((m) => String(m.person))), ...r.left.map((l) => String(l.person)), ...r.extras.map((x) => x.person && String(x.person)).filter(Boolean)]))];
  const [hostels, cycles, lessons, people] = await Promise.all([
    Hostel.find({ _id: { $in: hostelIds } }).select("name kind contacts contact").lean(),
    Cycle.find({ _id: { $in: cycleIds } }).select("subject hostel teacher schedule").populate("subject", "name").populate("teacher", "firstName lastName").lean(),
    cycleIds.length && dates.length ? Lesson.find({ world, source: "live", cycle: { $in: cycleIds }, date: { $in: dates } }).select("cycle date attendance").lean() : [],
    personIds.length ? Person.find({ _id: { $in: personIds } }).select("firstName lastName gender").lean() : [],
  ]);
  return {
    hostelById: new Map(hostels.map((h) => [String(h._id), h])),
    cycleById: new Map(cycles.map((c) => [String(c._id), c])),
    lessonByKey: new Map(lessons.map((l) => [`${l.cycle}|${new Date(l.date).toISOString()}`, { _id: l._id, reported: (l.attendance || []).length > 0 }])),
    personById: new Map(people.map((p) => [String(p._id), p])),
  };
}

const cycleView = (c) => (c ? { _id: c._id, name: c.subject?.name || "קורס", teacher: c.teacher ? personName(c.teacher) : null } : null);
const personView = (facts, id) => {
  const p = facts.personById.get(String(id));
  return { _id: id, name: p ? personName(p) : "", gender: p?.gender || null };
};

function sessionView(s, facts, today) {
  const existing = facts.lessonByKey.get(`${s.cycle}|${new Date(s.date).toISOString()}`);
  const marks = s.marks.map((m) => ({ person: personView(facts, m.person), status: m.status, reason: m.reason || null, reasonLabel: m.reason ? REASON_LABEL[m.reason] : null, note: m.note || null }));
  return {
    _id: s._id,
    cycle: cycleView(facts.cycleById.get(String(s.cycle))),
    date: s.date,
    start: s.start,
    end: s.end,
    state: s.state || null,
    markedAt: s.markedAt || null,
    marks,
    present: marks.filter((m) => m.status === "present").length,
    absent: marks.filter((m) => m.status === "absent").length,
    lesson: s.lesson || existing?._id || null,
    reported: !!existing?.reported,
    approvedAt: s.approvedAt || null,
    approvedBy: s.approvedBy || null,
    future: dayKey(s.date) > today,
  };
}

/** Where a house's month stands - from the facts, never set by hand. */
function statusOf(r) {
  const marked = r.sessions.filter((s) => s.state);
  if (r.completedAt && marked.length && marked.every((s) => s.approvedAt)) return "approved";
  if (r.completedAt) return "done";
  if (marked.length || r.extras.length || r.left.length) return "partial";
  if (r.openedAt) return "opened";
  if (r.sentAt) return "sent";
  return "new";
}

function countsOf(sessions, r) {
  const c = { sessions: sessions.length, past: 0, held: 0, notHeld: 0, unmarked: 0, approved: 0, toApprove: 0, present: 0, absent: 0, reportedElsewhere: 0, extras: 0, left: 0 };
  for (const s of sessions) {
    if (!s.future) c.past++;
    if (s.state === "held") c.held++;
    else if (s.state === "notHeld") c.notHeld++;
    else if (!s.future) c.unmarked++;
    if (s.approvedAt) c.approved++;
    else if (s.state) c.toApprove++;
    c.present += s.present;
    c.absent += s.absent;
    if (s.reported && !s.approvedAt) c.reportedElsewhere++;
  }
  c.extras = r.extras.filter((x) => !x.resolvedAt).length;
  c.left = r.left.filter((x) => !x.resolvedAt).length;
  return c;
}

function reportView(r, facts, today = todayKey()) {
  const h = facts.hostelById.get(String(r.hostel));
  const sessions = r.sessions.map((s) => sessionView(s, facts, today));
  const status = statusOf(r);
  return {
    _id: r._id,
    world: r.world,
    hostel: h ? { _id: h._id, name: h.name, kind: h.kind || "hostel", title: hostelTitle(h) } : { _id: r.hostel, name: "", kind: "hostel", title: "" },
    month: r.month,
    monthLabel: monthLabel(r.month),
    token: r.token,
    expiresAt: r.expiresAt,
    linkLive: r.expiresAt.getTime() > Date.now(),
    contact: { name: r.contact?.name || "", phone: r.contact?.phone || "" },
    openedBy: r.openedBy || null,
    sentAt: r.sentAt || null,
    sentBy: r.sentBy || null,
    openedAt: r.openedAt || null,
    lastOpenedAt: r.lastOpenedAt || null,
    completedAt: r.completedAt || null,
    note: r.note || null,
    staffNote: r.staffNote || null,
    status,
    statusLabel: HOSTEL_REPORT_STATUS_LABELS[status],
    counts: countsOf(sessions, r),
    sessions,
    extras: r.extras.map((x) => ({ _id: x._id, name: x.name, note: x.note || null, cycle: cycleView(facts.cycleById.get(String(x.cycle))), addedAt: x.addedAt, person: x.person ? personView(facts, x.person) : null, resolvedAt: x.resolvedAt || null, resolvedBy: x.resolvedBy || null })),
    left: r.left.map((l) => ({ _id: l._id, person: personView(facts, l.person), date: l.date, note: l.note || null, addedAt: l.addedAt, resolvedAt: l.resolvedAt || null, resolvedBy: l.resolvedBy || null })),
  };
}

async function viewsOf(world, reports) {
  const facts = await factsOf(world, reports);
  const today = todayKey();
  return reports
    .map((r) => reportView(r, facts, today))
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.hostel.name.localeCompare(b.hostel.name, "he")));
}

/** Every report of the world, newest month first, houses by name - each live one brought up to the house's courses. */
async function listReports({ world }) {
  const reports = await HostelReport.find({ world });
  for (const r of reports) await syncSessions(r);
  return viewsOf(world, reports);
}

async function getReport({ world, reportId }) {
  const [view] = await viewsOf(world, [await syncSessions(await loadReport({ world, reportId }))]);
  return view;
}

/* ───────────────────────── the coordinator's moves ───────────────────────── */

async function markSent({ world, reportId, by }) {
  const r = await loadReport({ world, reportId });
  r.sentAt = new Date();
  r.sentBy = clean(by, 80);
  await r.save();
  return getReport({ world, reportId });
}

async function renew({ world, reportId, days }) {
  const r = await loadReport({ world, reportId });
  const n = Number(days) > 0 ? Math.min(Number(days), 90) : HOSTEL_REPORT_LINK_DAYS;
  r.expiresAt = new Date(Date.now() + n * DAY_MS);
  await r.save();
  return getReport({ world, reportId });
}

/** The contact pressed סיימתי too soon - open it back. */
async function reopen({ world, reportId }) {
  const r = await loadReport({ world, reportId });
  r.completedAt = undefined;
  await r.save();
  return getReport({ world, reportId });
}

async function setStaffNote({ world, reportId, note }) {
  const r = await loadReport({ world, reportId });
  r.staffNote = clean(note, 1000);
  await r.save();
  return getReport({ world, reportId });
}

/** A month opened by mistake - gone, unless a session of it was already approved. */
async function deleteReport({ world, reportId }) {
  const r = await loadReport({ world, reportId });
  if (r.sessions.some((s) => s.approvedAt)) throw AppError.of("HOSTEL_REPORT_HAS_APPROVED", 409);
  await HostelReport.deleteOne({ _id: r._id });
}

/** The attendance status a mark becomes. */
const statusOfMark = (m) => (m.status === "present" ? "Present" : "Missing");

/**
 * The coordinator's word on one session: a held one becomes the Lesson's
 * attendance (the marks replace the rows of the same people; other rows
 * stay), reasons included; a session that was not held is noted and
 * leaves no lesson.
 */
async function approveOne(r, s, by) {
  if (!s.state) throw AppError.of("HOSTEL_REPORT_NOT_MARKED", 400);
  if (s.approvedAt) throw AppError.of("HOSTEL_REPORT_APPROVED", 400);
  if (s.state === "held") {
    const lesson = await Lesson.findOneAndUpdate(
      { cycle: s.cycle, date: s.date, source: "live" },
      { $setOnInsert: { world: r.world, attendance: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const rows = new Map((lesson.attendance || []).map((a) => [String(a.student), a]));
    for (const m of s.marks) {
      rows.set(String(m.person), { student: m.person, status: statusOfMark(m), reason: m.status === "absent" ? m.reason || null : null, note: m.note || undefined });
    }
    lesson.attendance = [...rows.values()];
    await lesson.save();
    s.lesson = lesson._id;
  }
  s.approvedAt = new Date();
  s.approvedBy = clean(by, 80);
}

async function approveSession({ world, reportId, sessionId, by }) {
  const r = await loadReport({ world, reportId });
  const s = r.sessions.id(sessionId);
  if (!s) throw AppError.of("HOSTEL_REPORT_SESSION_UNKNOWN", 400);
  await approveOne(r, s, by);
  await r.save();
  return getReport({ world, reportId });
}

/** Every marked session not yet approved, in one press. */
async function approveAll({ world, reportId, by }) {
  const r = await loadReport({ world, reportId });
  for (const s of r.sessions) if (s.state && !s.approvedAt) await approveOne(r, s, by);
  await r.save();
  return getReport({ world, reportId });
}

/**
 * A resident of the hostels alone: a person with a StudentCollege profile
 * (where the residence lives) and the `student` + `hostels` tags - never
 * the college's (the profile is made here, not through createProfile,
 * which would hand out the college tag with it). The import and the
 * coordinator's "הוספה לרשימה" make people this way.
 */
async function createResident({ world, firstName, lastName = "", gender, phone, birthDate, hostel, since, notes, by }) {
  const name = clean(firstName, 80);
  if (!name) throw AppError.of("MISSING_FIELDS", 400, "firstName");
  const person = await Person.create({ world, firstName: name, lastName: clean(lastName, 80) || "", ...(gender && { gender }), ...(phone && { phone }), ...(birthDate && { birthDate }) });
  const h = hostel ? await Hostel.findById(hostel).select("name kind").lean() : null;
  const profile = new MODEL_BY_KIND.StudentCollege({ person: person._id, world, ...(notes && { notes }), ...(h && { residence: { hostel: h._id, label: hostelTitle(h), since: since || new Date() } }) });
  profile.$locals.openedBy = by;
  await profile.save();
  await tags.give({ world, personId: person._id, key: "student", by });
  await tags.give({ world, personId: person._id, key: "hostels", by, note: "דייר/ת בהוסטל" });
  return { person, profile };
}

/** The person lives in this house from `since` (a residence elsewhere, or one that ended, is replaced). */
async function ensureResidence({ world, personId, hostel, since, by }) {
  let profile = await Profile.findOne({ person: personId, kind: "StudentCollege" });
  const h = await Hostel.findById(hostel).select("name kind").lean();
  if (!profile) {
    profile = new MODEL_BY_KIND.StudentCollege({ person: personId, world, residence: { hostel: h._id, label: hostelTitle(h), since: since || new Date() } });
    profile.$locals.openedBy = by;
    await profile.save();
    await tags.give({ world, personId, key: "student", by });
    return profile;
  }
  const cur = profile.residence || {};
  const livesHere = String(cur.hostel || "") === String(h._id) && !(cur.until && new Date(cur.until).getTime() <= Date.now());
  if (!livesHere) {
    profile.residence = { hostel: h._id, label: hostelTitle(h), since: since || new Date(), until: null };
    await profile.save();
  }
  return profile;
}

/**
 * "הוספה לרשימה": the someone-not-on-the-list becomes a person of ours -
 * an existing one (`person`) or a new resident (`firstName`…) - living in
 * this house, in the הוסטלים program, seated in the course they came to.
 */
async function resolveExtra({ world, reportId, extraId, person, firstName, lastName, gender, by }) {
  const r = await loadReport({ world, reportId });
  const x = r.extras.id(extraId);
  if (!x) throw AppError.of("NOT_FOUND", 404, "מי שלא ברשימה");
  if (x.resolvedAt) throw AppError.of("HOSTEL_REPORT_RESOLVED", 400);
  let personId;
  if (person) {
    const p = isId(person) && (await Person.findOne({ _id: person, world, deletedAt: null }).select("_id").lean());
    if (!p) throw AppError.of("HOSTEL_REPORT_PERSON", 400);
    personId = p._id;
    await ensureResidence({ world, personId, hostel: r.hostel, by });
    if (!(await tags.holds(personId, world, "hostels"))) await tags.give({ world, personId, key: "hostels", by, note: "נוסף/ה מהדיווח של ההוסטל" });
  } else {
    const made = await createResident({ world, firstName, lastName, gender, hostel: r.hostel, by });
    personId = made.person._id;
  }
  if (x.cycle) {
    const { enroll } = require("./enrollmentService");
    try {
      await enroll({ cycleId: x.cycle, studentId: personId, world, status: "active", createdBy: by, note: "נוסף/ה מהדיווח של ההוסטל" });
    } catch (e) {
      if (e.code !== "DUPLICATE_ENROLLMENT") throw e;
    }
  }
  x.person = personId;
  x.resolvedAt = new Date();
  x.resolvedBy = clean(by, 80);
  await r.save();
  return getReport({ world, reportId });
}

/** "סגירת המגורים": the leaver's residence ends on the day the house said; their seats in the house's courses end with it. */
async function resolveLeft({ world, reportId, leftId, by }) {
  const r = await loadReport({ world, reportId });
  const l = r.left.id(leftId);
  if (!l) throw AppError.of("NOT_FOUND", 404, "מי שעזב/ה");
  if (l.resolvedAt) throw AppError.of("HOSTEL_REPORT_RESOLVED", 400);
  const profile = await Profile.findOne({ person: l.person, kind: "StudentCollege" });
  if (profile && (!profile.residence?.hostel || String(profile.residence.hostel) === String(r.hostel))) {
    profile.residence = { ...(profile.residence?.toObject ? profile.residence.toObject() : profile.residence || {}), hostel: profile.residence?.hostel || r.hostel, until: l.date };
    await profile.save();
  }
  const cycles = await Cycle.find({ world, hostel: r.hostel }).select("_id").lean();
  const seats = await Enrollment.find({ world, student: l.person, cycle: { $in: cycles.map((c) => c._id) }, status: { $in: OCCUPYING_STATUSES } }).select("_id joinedAt").lean();
  const { updateStatus } = require("./enrollmentService");
  for (const e of seats) {
    // a seat ends on the day they left - never before it began
    const leftAt = e.joinedAt && new Date(e.joinedAt) > new Date(l.date) ? new Date(e.joinedAt) : l.date;
    await updateStatus({ enrollmentId: e._id, world, status: "left", leftAt, movedBy: by, note: "עזב/ה את ההוסטל - לפי הדיווח של הבית" });
  }
  l.resolvedAt = new Date();
  l.resolvedBy = clean(by, 80);
  await r.save();
  return getReport({ world, reportId });
}

/* ───────────────────────── the house's side (behind the link) ───────────────────────── */

async function resolveToken({ world, token }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("HOSTEL_REPORT_LINK_INVALID", 404);
  const r = await HostelReport.findOne({ world, token: t });
  if (!r) throw AppError.of("HOSTEL_REPORT_LINK_INVALID", 404);
  if (!r.linkLive()) throw AppError.of("HOSTEL_REPORT_LINK_EXPIRED", 410);
  return r;
}

/** The contact opened the page - noted once as the first time, always as the last (best effort). */
async function noteOpened(r) {
  const now = new Date();
  const first = !r.openedAt;
  if (first) r.openedAt = now;
  r.lastOpenedAt = now;
  try {
    await r.save();
  } catch (err) {
    console.error("hostel report link: the opening was not noted -", err.message);
    if (first) r.openedAt = undefined;
  }
  return r;
}

/** What the house's page reads: its month, its courses with their people, its sessions - and nothing of the attendance itself. */
async function publicView(r) {
  const facts = await factsOf(r.world, [r]);
  const today = todayKey();
  const h = facts.hostelById.get(String(r.hostel));
  const cycleIds = [...new Set(r.sessions.map((s) => String(s.cycle)))];
  const rosters = await rostersOf(r.world, cycleIds);
  const openLeft = new Set(r.left.filter((l) => !l.resolvedAt).map((l) => String(l.person)));
  const sessions = r.sessions.map((s) => sessionView(s, facts, today));
  const courses = cycleIds.map((k) => ({
    cycle: cycleView(facts.cycleById.get(k)),
    roster: (rosters.get(k) || []).map((p) => ({ _id: p._id, name: personName(p), gender: p.gender || null, left: openLeft.has(String(p._id)) })),
    sessions: sessions.filter((s) => String(s.cycle?._id) === k).map((s) => ({ _id: s._id, date: s.date, start: s.start, end: s.end, state: s.state, marks: s.marks.map((m) => ({ person: m.person._id, status: m.status, reason: m.reason, note: m.note })), present: s.present, absent: s.absent, locked: !!s.approvedAt, future: s.future })),
  }));
  return {
    hostel: { name: h?.name || "", kind: h?.kind || "hostel", title: hostelTitle(h) },
    month: r.month,
    monthLabel: monthLabel(r.month),
    contact: r.contact?.name || "",
    coordinator: r.sentBy || r.openedBy || null,
    expiresAt: r.expiresAt,
    today,
    done: !!r.completedAt,
    completedAt: r.completedAt || null,
    note: r.note || null,
    reasons: ABSENCE_REASONS,
    counts: countsOf(sessions, r),
    courses,
    extras: r.extras.map((x) => ({ _id: x._id, name: x.name, note: x.note || null, cycle: x.cycle ? String(x.cycle) : null, addedAt: x.addedAt, resolved: !!x.resolvedAt })),
    left: r.left.map((l) => ({ _id: l._id, person: personView(facts, l.person), date: l.date, note: l.note || null, resolved: !!l.resolvedAt })),
  };
}

const assertOpen = (r) => {
  if (r.completedAt) throw AppError.of("HOSTEL_REPORT_DONE", 400);
};

/**
 * The house's word on one session: held / not held, and who came. A mark
 * is { person, status present|absent, reason (an absent one must have it),
 * note }. Only people on the course's list; only once the day came; never
 * on a session the coordinator approved.
 */
async function setSession(r, sessionId, { state, marks }) {
  assertOpen(r);
  const s = r.sessions.id(sessionId);
  if (!s) throw AppError.of("HOSTEL_REPORT_SESSION_UNKNOWN", 400);
  if (s.approvedAt) throw AppError.of("HOSTEL_REPORT_APPROVED", 400);
  if (dayKey(s.date) > todayKey()) throw AppError.of("HOSTEL_REPORT_SESSION_FUTURE", 400);
  const st = state == null || state === "" ? null : state;
  if (st !== null && !HOSTEL_REPORT_SESSION_STATES.includes(st)) throw AppError.of("HOSTEL_REPORT_SESSION_STATE", 400);
  let rows = [];
  if (st === "held" && Array.isArray(marks)) {
    const roster = new Set(((await rostersOf(r.world, [String(s.cycle)])).get(String(s.cycle)) || []).map((p) => String(p._id)));
    const seen = new Set();
    for (const m of marks) {
      if (!m || !isId(m.person) || !HOSTEL_REPORT_MARKS.includes(m.status)) throw AppError.of("HOSTEL_REPORT_MARK_INVALID", 400);
      if (!roster.has(String(m.person))) throw AppError.of("HOSTEL_REPORT_NOT_IN_LIST", 400);
      if (seen.has(String(m.person))) continue;
      seen.add(String(m.person));
      const reason = m.status === "absent" ? m.reason : null;
      if (m.status === "absent" && !ABSENCE_REASON_KEYS.includes(reason)) throw AppError.of("HOSTEL_REPORT_REASON_REQUIRED", 400);
      rows.push({ person: m.person, status: m.status, reason, note: clean(m.note, 200) });
    }
  }
  s.state = st;
  s.marks = rows;
  s.markedAt = new Date();
  await r.save();
  return r;
}

/** Someone came who is not on the list - a name, maybe which course, maybe a word. */
async function addExtra(r, { name, note, cycle }) {
  assertOpen(r);
  const n = clean(name, 80);
  if (!n) throw AppError.of("HOSTEL_REPORT_EXTRA_NAME", 400);
  const c = cycle && isId(cycle) && r.sessions.some((s) => String(s.cycle) === String(cycle)) ? cycle : null;
  r.extras.push({ name: n, note: clean(note, 300), cycle: c });
  await r.save();
  return r;
}

async function removeExtra(r, extraId) {
  assertOpen(r);
  const x = r.extras.id(extraId);
  if (!x) throw AppError.of("NOT_FOUND", 404, "מי שלא ברשימה");
  if (x.resolvedAt) throw AppError.of("HOSTEL_REPORT_RESOLVED", 400);
  x.deleteOne();
  await r.save();
  return r;
}

/** A resident left the house - who, since when (a day), maybe a word. Only someone on one of the lists. */
async function addLeft(r, { person, date, note }) {
  assertOpen(r);
  if (!isId(person)) throw AppError.of("HOSTEL_REPORT_PERSON", 400);
  const rosters = await rostersOf(r.world, [...new Set(r.sessions.map((s) => String(s.cycle)))]);
  const listed = [...rosters.values()].some((list) => list.some((p) => String(p._id) === String(person)));
  if (!listed) throw AppError.of("HOSTEL_REPORT_NOT_IN_LIST", 400);
  const d = date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? `${date}T00:00:00.000Z` : date) : new Date();
  if (Number.isNaN(d.getTime())) throw AppError.of("INVALID_DATE", 400);
  const open = r.left.find((l) => String(l.person) === String(person) && !l.resolvedAt);
  if (open) {
    open.date = d;
    if (note !== undefined) open.note = clean(note, 300);
  } else r.left.push({ person, date: d, note: clean(note, 300) });
  await r.save();
  return r;
}

async function removeLeft(r, leftId) {
  assertOpen(r);
  const l = r.left.id(leftId);
  if (!l) throw AppError.of("NOT_FOUND", 404, "מי שעזב/ה");
  if (l.resolvedAt) throw AppError.of("HOSTEL_REPORT_RESOLVED", 400);
  l.deleteOne();
  await r.save();
  return r;
}

/** סיימתי - once something was marked. */
async function complete(r, { note } = {}) {
  assertOpen(r);
  if (!r.sessions.some((s) => s.state)) throw AppError.of("HOSTEL_REPORT_NOT_MARKED", 400);
  r.completedAt = new Date();
  if (note !== undefined) r.note = clean(note, 1000);
  await r.save();
  return r;
}

/* ───────────────────────── the Ministry of Health's monthly report ───────────────────────── */

const HE_MONTHS_SHORT = ["ינו", "פבר", "מרץ", "אפר", "מאי", "יוני", "יולי", "אוג", "ספט", "אוק", "נוב", "דצמ"];

/** "מעל 4 שנים" / "שנה" / "מרץ-26" - the way her file says when a house began. */
function sinceLabel(since, at = new Date()) {
  if (!since) return "";
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return "";
  const years = Math.floor((at - d) / (365.25 * DAY_MS));
  if (years >= 2) return `מעל ${years} שנים`;
  if (years === 1) return "מעל שנה";
  return `${HE_MONTHS_SHORT[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
}

/**
 * The rows of the month: every active HOSTEL (a קהילה never), each of its
 * courses live in the month with the average attendance over the lessons
 * reported in it - the approvals and the activity start beside them.
 */
async function ministryRows({ world, month }) {
  if (!MONTH_RE.test(String(month || ""))) throw AppError.of("HOSTEL_REPORT_MONTH", 400);
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0));
  const hostels = await Hostel.find({ world, active: { $ne: false }, kind: { $ne: "community" } }).sort({ name: 1 }).lean();
  const rows = [];
  for (const h of hostels) {
    const cycles = await cyclesOfMonth({ world, hostelId: h._id, month });
    const named = await Cycle.find({ _id: { $in: cycles.map((c) => c._id) } }).select("subject teacher").populate("subject", "name").populate("teacher", "firstName lastName").lean();
    const lessons = await Lesson.find({ world, source: "live", cycle: { $in: cycles.map((c) => c._id) }, date: { $gte: from, $lte: to } }).select("cycle attendance").lean();
    const courses = named
      .map((c) => {
        const mine = lessons.filter((l) => String(l.cycle) === String(c._id) && (l.attendance || []).length > 0);
        const present = mine.map((l) => l.attendance.filter((a) => a.status === "Present").length);
        const avg = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
        return { _id: c._id, name: c.subject?.name || "קורס", teacher: c.teacher ? personName(c.teacher) : null, lessons: mine.length, avg };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
    rows.push({ hostel: { _id: h._id, name: h.name }, since: h.since || null, sinceLabel: sinceLabel(h.since), approvals: h.approvals ?? null, courses });
  }
  return { month, monthLabel: monthLabel(month), rows };
}

/** Her Excel: one row per course, the house's name / start / approvals merged down its courses. */
async function ministryXlsx({ world, month }) {
  const data = await ministryRows({ world, month });
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "שק״ל";
  const ws = wb.addWorksheet(`דוח ${data.monthLabel}`, { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: "שם ההוסטל", key: "hostel", width: 24 },
    { header: "תחילת פעילות", key: "since", width: 16 },
    { header: "חוג מועבר בהוסטל", key: "course", width: 22 },
    { header: "מספר אישורים בהוסטל", key: "approvals", width: 22 },
    { header: "מספר משתתפים בפועל (בממוצע) נתון משתנה", key: "avg", width: 40 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6E3DA" } };
  head.height = 32;
  let row = 2;
  for (const r of data.rows) {
    const courses = r.courses.length ? r.courses : [{ name: "", avg: null }];
    const first = row;
    for (const c of courses) {
      ws.addRow({ hostel: r.hostel.name, since: r.sinceLabel, course: c.name, approvals: r.approvals ?? "", avg: c.avg ?? "" });
      row++;
    }
    const last = row - 1;
    if (last > first) {
      ws.mergeCells(`A${first}:A${last}`);
      ws.mergeCells(`B${first}:B${last}`);
      ws.mergeCells(`D${first}:D${last}`);
    }
  }
  ws.eachRow((r, i) => {
    r.alignment = { ...(r.alignment || {}), horizontal: "center", vertical: "middle", wrapText: true };
    r.eachCell((cell) => {
      cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
    });
    if (i > 1) r.height = 20;
  });
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), fileName: `דוח משרד הבריאות - ${data.monthLabel}.xlsx`, data };
}

module.exports = {
  reporterOf,
  openMonth,
  syncSessions,
  listReports,
  getReport,
  loadReport,
  markSent,
  renew,
  reopen,
  setStaffNote,
  deleteReport,
  approveSession,
  approveAll,
  createResident,
  ensureResidence,
  resolveExtra,
  resolveLeft,
  resolveToken,
  noteOpened,
  publicView,
  setSession,
  addExtra,
  removeExtra,
  addLeft,
  removeLeft,
  complete,
  sinceLabel,
  ministryRows,
  ministryXlsx,
};
