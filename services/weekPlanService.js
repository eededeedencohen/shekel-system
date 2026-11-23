/**
 * The hostels teachers' week census (models/WeekPlan): the staff's side
 * (list, open a form, the link and its day, sent, entries typed by the
 * staff) and the teacher's side behind the personal link (read - which
 * notes the opening - write an entry, hand the week in).
 *
 * Nothing here reads or writes a course: it is a list of what people SAY
 * their week is, to be settled into the real data later, by hand.
 *
 * A form can be ONE person's for several teachers (`cover`; Eden, 2026-11-23:
 * "אני רוצה שחוסאם ימלא עבור כל המורים של הוסטל השלום… כל שיעור חייבים לשייך
 * לו מורה"): then every lesson names its teacher, one of the form's. And what
 * was written before a fresh start is set aside (`setAside`): kept, not counted.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const AppError = require("../utils/AppError");
const WeekPlan = require("../models/WeekPlan");
const { HHMM } = require("../models/WeekPlan");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const Subject = require("../models/Subject");
const { linkExpiryFrom } = require("../utils/linkWindow");

/** A new form's link is open this long unless a day is named. */
const WEEK_PLAN_LINK_DAYS = 14;
const MAX_ENTRIES = 60;
const isId = (v) => mongoose.isValidObjectId(v);
const makeToken = () => crypto.randomBytes(18).toString("base64url");
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const live = (p) => new Date(p.expiresAt).getTime() > Date.now();
const LANGS = ["he", "ar"];
const langOf = (v) => (LANGS.includes(v) ? v : "he");

const TEACHER_FIELDS = "firstName lastName gender phone";
const NAME_FIELDS = "firstName lastName gender";
const POP = [
  { path: "teacher", select: TEACHER_FIELDS },
  { path: "entries.hostel", select: "name kind" },
  { path: "entries.teacher", select: NAME_FIELDS },
  { path: "aside.hostel", select: "name kind" },
  { path: "covers", select: NAME_FIELDS },
  { path: "coversHostel", select: "name kind" },
];
const nameView = (x) => (x && x._id ? { _id: String(x._id), firstName: x.firstName || "", lastName: x.lastName || "", gender: x.gender || null } : null);
const houseView = (h) => (h && h._id ? { _id: String(h._id), name: h.name || "", kind: h.kind || "hostel" } : null);
const fullName = (x) => `${x?.firstName || ""} ${x?.lastName || ""}`.trim();

const entryView = (e) => ({
  _id: String(e._id),
  day: e.day,
  start: e.start,
  end: e.end,
  subject: e.subject,
  hostel: e.hostel ? { _id: String(e.hostel._id || e.hostel), name: e.hostel.name || "", kind: e.hostel.kind || "hostel" } : null,
  hostelName: e.hostelName || "",
  place: e.place,
  note: e.note || "",
  // whose lesson it is, where the form is one person's for several teachers
  teacher: nameView(e.teacher),
  by: e.by,
  byName: e.byName || "",
  at: e.at,
});
const sortEntries = (list) => list.slice().sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));

/** The plan as the staff read it - never the token (GET …/link hands it, alone). */
const planView = (p) => ({
  _id: String(p._id),
  teacher: p.teacher ? { _id: String(p.teacher._id), firstName: p.teacher.firstName || "", lastName: p.teacher.lastName || "", gender: p.teacher.gender || null, phone: p.teacher.phone || "" } : null,
  expiresAt: p.expiresAt,
  live: live(p),
  openedBy: p.openedBy || "",
  lang: langOf(p.lang),
  sentAt: p.sentAt || null,
  sentBy: p.sentBy || "",
  openedAt: p.openedAt || null,
  lastOpenedAt: p.lastOpenedAt || null,
  opens: p.opens || 0,
  teacherEditedAt: p.teacherEditedAt || null,
  submittedAt: p.submittedAt || null,
  note: p.note || "",
  entries: sortEntries(p.entries || []).map(entryView),
  // one person's form for several teachers: who they are, and of which house
  covers: (p.covers || []).map(nameView).filter(Boolean),
  coversHostel: houseView(p.coversHostel),
  // what was written before and is not counted any more
  aside: sortEntries(p.aside || []).map(entryView),
  asideNote: p.asideNote || "",
  asideAt: p.asideAt || null,
  createdAt: p.createdAt,
});

const requirePlan = async (id) => {
  const p = isId(id) && (await WeekPlan.findById(id));
  if (!p) throw AppError.of("NOT_FOUND", 404, "טופס השבוע");
  return p;
};
const shaped = async (p) => planView(await p.populate(POP));

const coverIds = (p) => (p.covers || []).map((x) => String(x._id || x));

/**
 * An entry as it may be kept: every field checked, the house one of ours or a typed name. In a form filled for
 * several teachers (`plan.covers`) the lesson must name its teacher, one of them; in any other form it has none.
 */
async function entryOf(data, who, plan) {
  const d = data || {};
  const day = Number(d.day);
  const start = String(d.start || "");
  const end = String(d.end || "");
  const subject = clean(d.subject, 80);
  const place = d.place;
  const hostelName = clean(d.hostelName, 80);
  let hostel = null;
  if (d.hostel) {
    if (!isId(d.hostel) || !(await Hostel.exists({ _id: d.hostel }))) throw AppError.of("WEEK_PLAN_ENTRY_INVALID", 400);
    hostel = d.hostel;
  }
  const covered = coverIds(plan || {});
  // "מטי" is a place only of a form filled for several teachers (the form of הוסטל השלום)
  const places = covered.length ? ["hostel", "shekel", "mati"] : ["hostel", "shekel"];
  const good = Number.isInteger(day) && day >= 0 && day <= 4 && HHMM.test(start) && HHMM.test(end) && end > start && subject && places.includes(place) && (hostel || hostelName);
  if (!good) throw AppError.of("WEEK_PLAN_ENTRY_INVALID", 400);
  if (covered.length && !covered.includes(String(d.teacher || ""))) throw AppError.of("WEEK_PLAN_ENTRY_TEACHER", 400);
  const teacher = covered.length ? String(d.teacher) : null;
  return { day, start, end, subject, hostel, hostelName: hostel ? "" : hostelName, place, note: clean(d.note, 200), teacher, by: who.by, byName: clean(who.name, 80), at: new Date() };
}

function putEntry(p, entryId, fields) {
  if (entryId) {
    const e = p.entries.id(entryId);
    if (!e) throw AppError.of("NOT_FOUND", 404, "שיעור");
    Object.assign(e, fields);
  } else {
    if (p.entries.length >= MAX_ENTRIES) throw AppError.of("WEEK_PLAN_ENTRY_INVALID", 400);
    p.entries.push(fields);
  }
}

/* ───────────────────────── the staff ───────────────────────── */

/**
 * Every form, and who else it makes sense to open one for: the teachers of an active course of a house
 * (`suggested`, person ids) - the page offers them in one press.
 */
async function list() {
  const [plans, cycles] = await Promise.all([
    WeekPlan.find().populate(POP).sort({ createdAt: 1 }),
    Cycle.find({ hostel: { $ne: null }, status: "Active", teacher: { $ne: null } }).select("teacher").lean(),
  ]);
  const have = new Set(plans.map((p) => String(p.teacher?._id || p.teacher)));
  const suggested = [...new Set(cycles.map((c) => String(c.teacher)))].filter((id) => !have.has(id));
  return { plans: plans.filter((p) => p.teacher).map(planView), suggested };
}

/** Open a form for these teachers (whoever has one already keeps it). `until`: the day the links close. */
async function open({ teachers, until, days, by, lang }) {
  const ids = [...new Set((Array.isArray(teachers) ? teachers : []).map(String))].filter(isId);
  if (!ids.length) throw AppError.of("MISSING_FIELDS", 400, "teachers");
  const expiresAt = linkExpiryFrom({ until, days }, WEEK_PLAN_LINK_DAYS);
  const people = await Person.find({ _id: { $in: ids }, deletedAt: null }).select("_id").lean();
  const made = [];
  const have = new Set((await WeekPlan.find({ teacher: { $in: people.map((x) => x._id) } }).select("teacher").lean()).map((x) => String(x.teacher)));
  for (const person of people) {
    if (have.has(String(person._id))) continue;
    try {
      made.push(await WeekPlan.create({ teacher: person._id, token: makeToken(), expiresAt, openedBy: clean(by, 80), lang: langOf(lang) }));
    } catch (err) {
      if (err?.code !== 11000) throw err; // a form of that teacher is there already
    }
  }
  return Promise.all(made.map(shaped));
}

async function link(id) {
  const p = await requirePlan(id);
  return { token: p.token, expiresAt: p.expiresAt };
}

async function markSent({ id, by }) {
  const p = await requirePlan(id);
  p.sentAt = new Date();
  p.sentBy = clean(by, 80);
  await p.save();
  return shaped(p);
}

/** Until when the link is open: through the end of a chosen day, or for `days` from now. */
async function renew({ id, until, days }) {
  const p = await requirePlan(id);
  p.expiresAt = linkExpiryFrom({ until, days }, WEEK_PLAN_LINK_DAYS);
  await p.save();
  return shaped(p);
}

/** The language the teacher's form opens in (the teacher can switch on the page). */
async function setLang({ id, lang }) {
  if (!LANGS.includes(lang)) throw AppError.of("MISSING_FIELDS", 400, "lang");
  const p = await requirePlan(id);
  p.lang = lang;
  await p.save();
  return shaped(p);
}

/** The week is open again for the teacher to hand in (what was written stays). */
async function reopen({ id }) {
  const p = await requirePlan(id);
  p.submittedAt = undefined;
  await p.save();
  return shaped(p);
}

/**
 * The form becomes ONE person's for several teachers: `teachers` (the form's own teacher is always among them)
 * and the house they are the teachers of. From here on every lesson written in it names its teacher.
 */
async function cover({ id, teachers, hostel }) {
  const p = await requirePlan(id);
  const ids = [...new Set([String(p.teacher), ...(Array.isArray(teachers) ? teachers : []).map(String)])].filter(isId);
  const people = await Person.find({ _id: { $in: ids }, deletedAt: null }).select("_id").lean();
  if (people.length !== ids.length || ids.length < 2) throw AppError.of("MISSING_FIELDS", 400, "teachers");
  if (hostel && (!isId(hostel) || !(await Hostel.exists({ _id: hostel })))) throw AppError.of("MISSING_FIELDS", 400, "hostel");
  p.covers = ids;
  p.coversHostel = hostel || null;
  // what stands in the form already is the form's own teacher's
  for (const e of p.entries) if (!e.teacher) e.teacher = p.teacher;
  await p.save();
  return shaped(p);
}

/**
 * A fresh start: what was written in the form so far (the lessons, the word, the handing in) is set aside -
 * kept, and out of every view of the week - and the link's story begins again, as a form not sent yet.
 */
async function setAside({ id, by }) {
  const p = await requirePlan(id);
  if (!p.entries.length && !p.note) return shaped(p);
  for (const e of p.entries) p.aside.push(e.toObject());
  p.entries = [];
  if (p.note) p.asideNote = [p.asideNote, p.note].filter(Boolean).join(" · ").slice(0, 500);
  p.note = "";
  p.asideAt = new Date();
  p.asideBy = clean(by, 80);
  for (const k of ["submittedAt", "teacherEditedAt", "sentAt", "sentBy", "openedAt", "lastOpenedAt"]) p[k] = undefined;
  p.opens = 0;
  await p.save();
  return shaped(p);
}

async function saveEntry({ id, entryId, data, by }) {
  const p = await requirePlan(id);
  putEntry(p, entryId, await entryOf(data, { by: "staff", name: by }, p));
  await p.save();
  return shaped(p);
}

async function removeEntry({ id, entryId }) {
  const p = await requirePlan(id);
  const e = p.entries.id(entryId);
  if (!e) throw AppError.of("NOT_FOUND", 404, "שיעור");
  e.deleteOne();
  await p.save();
  return shaped(p);
}

async function remove({ id }) {
  const p = await requirePlan(id);
  await p.deleteOne();
}

/* ───────────────────────── the teacher, behind the link ───────────────────────── */

async function byToken(token) {
  const p = typeof token === "string" && token.length >= 16 && (await WeekPlan.findOne({ token }));
  if (!p) throw AppError.of("NOT_FOUND", 404, "הקישור");
  return p;
}
const assertOpen = (p) => {
  if (!live(p)) throw AppError.of("WEEK_PLAN_LINK_CLOSED", 400);
};

/** What the teacher's page reads: the week so far, the houses to choose from, the subjects to offer. */
async function publicShape(p) {
  await p.populate(POP);
  const [hostels, profile, subjects] = await Promise.all([
    Hostel.find({ active: { $ne: false } }).select("name kind").sort({ name: 1 }).lean(),
    Profile.findOne({ person: p.teacher?._id, kind: "Teacher" }).populate({ path: "subjects", select: "name" }).lean(),
    Subject.find().select("name").sort({ name: 1 }).lean(),
  ]);
  const own = (profile?.subjects || []).map((s) => s.name).filter(Boolean);
  // a form filled for several teachers: who they are, and what stands in each one's OWN form so far
  // (the filler is told, so nothing a colleague wrote is missed)
  const covers = (p.covers || []).map(nameView).filter(Boolean);
  const others = covers.filter((c) => c._id !== String(p.teacher?._id));
  const theirs = others.length ? await WeekPlan.find({ teacher: { $in: others.map((c) => c._id) } }).select("teacher note entries._id").lean() : [];
  return {
    teacher: { _id: String(p.teacher?._id || ""), firstName: p.teacher?.firstName || "", lastName: p.teacher?.lastName || "", gender: p.teacher?.gender || null },
    covers: covers.map((c) => ({ _id: c._id, name: fullName(c) })),
    coversHostel: houseView(p.coversHostel),
    others: others.map((c) => {
      const form = theirs.find((x) => String(x.teacher) === c._id);
      return { _id: c._id, name: fullName(c), lessons: form?.entries?.length || 0, note: form?.note || "" };
    }),
    asideLessons: (p.aside || []).length,
    lang: langOf(p.lang),
    expiresAt: p.expiresAt,
    live: live(p),
    submittedAt: p.submittedAt || null,
    note: p.note || "",
    entries: sortEntries(p.entries || []).map(entryView),
    hostels: hostels.map((h) => ({ _id: String(h._id), name: h.name, kind: h.kind || "hostel" })),
    // the teacher's own subjects lead, the rest of the catalogue follows
    subjects: [...new Set([...own, ...subjects.map((s) => s.name).filter(Boolean)])],
    ownSubjects: own,
  };
}

/** The link was opened: the first time, the last time, how many times (a look by the staff does not go through here). */
async function publicView(token) {
  const p = await byToken(token);
  const now = new Date();
  if (!p.openedAt) p.openedAt = now;
  p.lastOpenedAt = now;
  p.opens = (p.opens || 0) + 1;
  await p.save();
  return publicShape(p);
}

async function publicSaveEntry({ token, entryId, data }) {
  const p = await byToken(token);
  assertOpen(p);
  await p.populate({ path: "teacher", select: TEACHER_FIELDS });
  putEntry(p, entryId, await entryOf(data, { by: "teacher", name: fullName(p.teacher) }, p));
  p.teacherEditedAt = new Date();
  await p.save();
  return publicShape(p);
}

async function publicRemoveEntry({ token, entryId }) {
  const p = await byToken(token);
  assertOpen(p);
  const e = p.entries.id(entryId);
  if (!e) throw AppError.of("NOT_FOUND", 404, "שיעור");
  e.deleteOne();
  p.teacherEditedAt = new Date();
  await p.save();
  return publicShape(p);
}

/** "זה השבוע שלי": handed in. A week with no lessons is handed in with a word. */
async function publicDone({ token, note }) {
  const p = await byToken(token);
  assertOpen(p);
  const text = clean(note, 500);
  if (!p.entries.length && !text) throw AppError.of("WEEK_PLAN_EMPTY", 400);
  p.note = text;
  p.submittedAt = new Date();
  p.teacherEditedAt = p.submittedAt;
  await p.save();
  return publicShape(p);
}

module.exports = { list, open, link, markSent, renew, reopen, setLang, cover, setAside, saveEntry, removeEntry, remove, publicView, publicSaveEntry, publicRemoveEntry, publicDone, WEEK_PLAN_LINK_DAYS };
