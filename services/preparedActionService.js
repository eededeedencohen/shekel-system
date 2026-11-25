/**
 * @file preparedActionService - the actions that wait for the super admin's approval, and the running of one
 * @module services/preparedActionService
 *
 * Eden (2026-11-25): "אתה יוצר פעולה ומתאר מה יהיה בפעולה ואני מתבונן ולוחץ אישור - כשאני לוחץ אישור אז הפעולה
 * מתבצעת… כמובן לא לדרוס את הנתונים הקיימים".
 *
 * An action is a list of STEPS (models/PreparedAction). Each kind of step is one small thing the app already
 * knows how to do, done HERE through the same services the pages use - never a raw write beside them:
 *
 *   teacher   { firstName, lastName, phone }                 a teacher by that exact name, made if there is none
 *   subject   { name, category }                             a course of the catalogue by that exact name
 *   student   { person } | { firstName, lastName, phone }    a person of ours (opened in מכללה לכל if not in it)
 *   cycle     { subject, teacher, schedule: [{ day, start, end, room }], startDate, endDate, format, capacity,
 *               senzeyCourseId, senzeyName }                  a running course; the old system's number ties it
 *   seat      { student, cycle }                             the student seated in the course (services/enrollmentService)
 *
 * A field that names another record may point at an earlier step: "$s1" = whatever that step made or found.
 *
 * NOTHING EXISTING IS OVERWRITTEN. Every step first LOOKS: what is already there is "found" and left exactly as
 * it is; only what is missing is made. The same look, done without writing, is what the page shows beside each
 * step before he approves (`will`): make / found / open (a person of ours, the college opened) / blocked.
 *
 * A step that fails does not stop the others; whatever leaned on it is skipped. The action then stands "partial",
 * and approving again runs what did not run. What HE left out before approving (an optional step, and whatever
 * leans on it) is not a failure: the action is done without it. An action runs once at a time (its status is flipped in one write).
 */

const mongoose = require("mongoose");
const PreparedAction = require("../models/PreparedAction");
const { STEP_KINDS } = require("../models/PreparedAction");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const Room = require("../models/Room");
const Enrollment = require("../models/Enrollment");
const { createProfile, createPersonWithProfile } = require("./profileService");
const { assertCategoryKey } = require("./subjectCategoryService");
const { enroll } = require("./enrollmentService");
const { normalizePhone, findPerson } = require("./intakeService");
const tags = require("./tagService");
const AppError = require("../utils/AppError");

const MAX_STEPS = 400;
const WAITING = ["ready", "partial"];
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).trim().replace(/\s+/g, " ").slice(0, max) : "");
const isId = (v) => typeof v === "string" && mongoose.isValidObjectId(v);
const isRef = (v) => typeof v === "string" && /^\$[a-z][a-z0-9]{0,18}$/.test(v);
const fold = (s) => text(s, 200).toLowerCase();
const invalid = (why) => AppError.of("ACTION_INVALID", 400, why);

/** "25/11/2026" or an ISO day → a Date (the day's own noon in UTC, so no time zone moves it), or null. */
function dayOf(v) {
  const s = String(v || "");
  const il = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!il && !iso) return null;
  const [y, m, day] = il ? [il[3], il[2], il[1]] : [iso[1], iso[2], iso[3]];
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, Number(day), 12));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(day) ? null : d;
}
const HOUR = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ───────── an action as it is written down: every step's data is checked against its kind ───────── */

/** Which earlier kinds a field may point at. */
const REF_KINDS = { subject: ["subject"], teacher: ["teacher"], student: ["student"], cycle: ["cycle"] };
function pointer(value, field, earlier, { optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw invalid(field);
  }
  if (isId(value)) return value;
  if (isRef(value)) {
    const kind = earlier.get(value.slice(1));
    if (!kind || !REF_KINDS[field].includes(kind)) throw invalid(`${field}: ${value}`);
    return value;
  }
  throw invalid(field);
}

const DATA = {
  teacher(d) {
    if (!text(d.firstName, 60)) throw invalid("teacher.firstName");
    return { firstName: text(d.firstName, 60), lastName: text(d.lastName, 60), phone: text(d.phone, 30) };
  },
  subject(d) {
    if (!text(d.name, 120)) throw invalid("subject.name");
    return { name: text(d.name, 120), category: text(d.category, 40) || "other" };
  },
  student(d) {
    if (d.person != null) {
      if (!isId(d.person)) throw invalid("student.person");
      return { person: d.person };
    }
    if (!text(d.firstName, 60)) throw invalid("student.firstName");
    return { firstName: text(d.firstName, 60), lastName: text(d.lastName, 60), phone: text(d.phone, 30) };
  },
  cycle(d, earlier) {
    const schedule = (Array.isArray(d.schedule) ? d.schedule : []).map((s) => {
      const day = Number(s?.day);
      if (!Number.isInteger(day) || day < 0 || day > 4 || !HOUR.test(s?.start) || !HOUR.test(s?.end) || s.end <= s.start) throw invalid("cycle.schedule");
      return { day, start: s.start, end: s.end, room: text(s.room, 60) };
    });
    if (!schedule.length || schedule.length > 7) throw invalid("cycle.schedule");
    const startDate = dayOf(d.startDate);
    const endDate = dayOf(d.endDate);
    if (!startDate || !endDate || endDate < startDate) throw invalid("cycle.dates");
    const capacity = Number(d.capacity);
    return {
      subject: pointer(d.subject, "subject", earlier),
      teacher: pointer(d.teacher, "teacher", earlier, { optional: true }),
      schedule,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      format: d.format === "Private" ? "Private" : "Group",
      capacity: Number.isInteger(capacity) && capacity > 0 && capacity < 1000 ? capacity : null,
      senzeyCourseId: text(d.senzeyCourseId, 30),
      senzeyName: text(d.senzeyName, 200),
    };
  },
  seat(d, earlier) {
    return { student: pointer(d.student, "student", earlier), cycle: pointer(d.cycle, "cycle", earlier) };
  },
};

function cleanAction(body) {
  if (!isMap(body) || !text(body.title, 160) || !Array.isArray(body.steps) || !body.steps.length || body.steps.length > MAX_STEPS) throw invalid("title / steps");
  const earlier = new Map();
  const steps = body.steps.map((s) => {
    if (!isMap(s) || !/^[a-z][a-z0-9]{0,18}$/.test(s.id || "") || earlier.has(s.id) || !STEP_KINDS.includes(s.kind) || !text(s.label, 240) || !isMap(s.data)) throw invalid(`step ${s?.id || ""}`);
    const data = DATA[s.kind](s.data, earlier);
    earlier.set(s.id, s.kind);
    return { id: s.id, kind: s.kind, label: text(s.label, 240), detail: text(s.detail, 400), data, optional: s.optional === true, on: s.on !== false };
  });
  return {
    title: text(body.title, 160),
    summary: text(body.summary, 2000),
    source: text(body.source, 600),
    notes: (Array.isArray(body.notes) ? body.notes : []).map((n) => text(n, 600)).filter(Boolean).slice(0, 40),
    steps,
  };
}

/* ───────── the look: what is already there (never writes) ───────── */

const nameOf = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ");

async function findTeacher({ firstName, lastName }) {
  const ids = await Profile.find({ kind: "Teacher", active: true }).distinct("person");
  const people = await Person.find({ _id: { $in: ids }, deletedAt: null }).select("firstName lastName").lean();
  return people.filter((p) => fold(p.firstName) === fold(firstName) && fold(p.lastName) === fold(lastName));
}

/** A person for a student step: by its id, else by the phone, else by the exact name. { person | null, many } */
async function findStudent(d) {
  if (d.person) return { person: await Person.findOne({ _id: d.person, deletedAt: null }), many: false, byId: true };
  const phone = normalizePhone(d.phone);
  if (phone) {
    const p = await findPerson({ phone });
    if (p) return { person: p, many: false };
  }
  const all = await Person.find({ deletedAt: null, firstName: new RegExp(`^\\s*${d.firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).select("firstName lastName");
  const same = all.filter((p) => fold(p.lastName) === fold(d.lastName));
  return { person: same.length === 1 ? same[0] : null, many: same.length > 1 };
}

/** The course a cycle step speaks of, when it is already there: by the old system's number, else by subject + teacher + first slot. */
async function findCycle(d, subjectId, teacherId) {
  if (d.senzeyCourseId) {
    const c = await Cycle.findOne({ "import.senzeyCourseId": d.senzeyCourseId });
    if (c) return c;
  }
  if (!subjectId) return null;
  const s = d.schedule[0];
  return Cycle.findOne({ subject: subjectId, teacher: teacherId || null, status: { $ne: "Cancelled" }, schedule: { $elemMatch: { day: s.day, start: s.start } } });
}

/** What a pointer stands for right now: an id, or null when the step it names has (so far) nothing to show. */
const pointed = (value, refs) => (isRef(value) ? refs.get(value.slice(1)) || null : value || null);

/**
 * One step, looked at: { state: "found" | "make" | "open" | "blocked", text, ref } ("open": a person of ours, for
 * whom the college will be opened - nobody is made).
 * `refs` = what earlier steps already stand for (their real ids); a step whose earlier step WILL be made has no id
 * to look with, and so will itself be made.
 */
async function look(step, refs, pending) {
  const d = step.data;
  if (step.kind === "teacher") {
    const found = await findTeacher(d);
    if (found.length > 1) return { state: "blocked", text: "יש במערכת יותר ממורה אחד בשם הזה" };
    return found.length ? { state: "found", text: `מורה במערכת: ${nameOf(found[0])}`, ref: String(found[0]._id) } : { state: "make", text: "אין במערכת מורה בשם הזה" };
  }
  if (step.kind === "subject") {
    const s = await Subject.findOne({ name: d.name });
    return s ? { state: "found", text: "הקורס כבר בקטלוג", ref: String(s._id) } : { state: "make", text: "אין בקטלוג קורס בשם הזה" };
  }
  if (step.kind === "student") {
    const { person, many, byId } = await findStudent(d);
    if (many) return { state: "blocked", text: "יש במערכת יותר מאדם אחד בשם הזה. צריך לבחור מי" };
    if (!person) return byId ? { state: "blocked", text: "האדם הזה כבר לא נמצא במערכת" } : { state: "make", text: "לא נמצא במערכת. ייפתח תיק סטודנט חדש במכללה לכל" };
    if (await tags.holds(person._id, "college")) return { state: "found", text: `במערכת, במכללה לכל: ${nameOf(person)}`, ref: String(person._id) };
    // a person of ours who is not in the college: nobody is made - the program is opened beside what the person has
    return { state: "open", text: `${nameOf(person)} במערכת, בלי מכללה לכל. התוכנית תיפתח, ושאר הפרטים לא ישתנו`, ref: String(person._id) };
  }
  if (step.kind === "cycle") {
    const subject = pointed(d.subject, refs);
    const teacher = pointed(d.teacher, refs);
    if ((isRef(d.subject) && !subject && !pending.has(d.subject.slice(1))) || (isRef(d.teacher) && !teacher && !pending.has(d.teacher.slice(1)))) return { state: "blocked", text: "תלוי בצעד שלא יתבצע" };
    const c = await findCycle(d, subject, teacher);
    return c ? { state: "found", text: "הקורס כבר במערכת", ref: String(c._id) } : { state: "make", text: "אין במערכת קורס כזה" };
  }
  // a seat
  const student = pointed(d.student, refs);
  const cycle = pointed(d.cycle, refs);
  if ((isRef(d.student) && !student && !pending.has(d.student.slice(1))) || (isRef(d.cycle) && !cycle && !pending.has(d.cycle.slice(1)))) return { state: "blocked", text: "תלוי בצעד שלא יתבצע" };
  if (student && cycle) {
    const e = await Enrollment.findOne({ cycle, student, status: { $in: ["reserved", "active"] } });
    if (e) return { state: "found", text: "כבר יש שיבוץ כזה", ref: cycle };
  }
  return { state: "make", text: "" };
}

/** Which earlier steps a step leans on (the page greys it when he takes one of them off). */
const needsOf = (step) => Object.values(step.data || {}).filter(isRef).map((v) => v.slice(1));

/** An action as the page reads it: no `data` (the labels say it), and beside every step that has not run what approving would do. */
async function forPage(doc) {
  const action = doc.toObject ? doc.toObject() : doc;
  const waiting = WAITING.includes(action.status);
  const refs = new Map();
  const pending = new Set();
  const steps = [];
  for (const step of action.steps) {
    const out = step.outcome?.status ? step.outcome : null;
    let will = null;
    if (out && (out.status === "made" || out.status === "found")) refs.set(step.id, out.refKind === "cycle" && step.kind === "seat" ? null : out.ref);
    else if (waiting) {
      will = await look(step, refs, pending);
      if (will.ref && will.state === "found") refs.set(step.id, will.ref);
      else if (will.state === "make" || will.state === "open") {
        pending.add(step.id);
        if (will.ref) refs.set(step.id, will.ref);
      }
      will = { state: will.state, text: will.text };
    }
    steps.push({ id: step.id, kind: step.kind, label: step.label, detail: step.detail, optional: step.optional, on: step.on, needs: needsOf(step), will, outcome: step.outcome || { status: null } });
  }
  return { _id: String(action._id), title: action.title, summary: action.summary, source: action.source, notes: action.notes, status: action.status, createdAt: action.createdAt, createdBy: action.createdBy, approvedBy: action.approvedBy, approvedAt: action.approvedAt, finishedAt: action.finishedAt, steps };
}

/* ───────── the doing: one step, through the app's own services ───────── */

class Leaning extends Error {}
const must = (value, refs) => {
  const id = pointed(value, refs);
  if (!id) throw new Leaning();
  return id;
};

const DO = {
  async teacher(d) {
    const found = await findTeacher(d);
    if (found.length > 1) throw AppError.of("ACTION_STEP", 409, "יש במערכת יותר ממורה אחד בשם הזה");
    if (found.length) return { status: "found", ref: String(found[0]._id), refKind: "teacher" };
    const phone = normalizePhone(d.phone);
    const { person } = await createPersonWithProfile("Teacher", { firstName: d.firstName, ...(d.lastName && { lastName: d.lastName }), ...(phone && { phone }) });
    return { status: "made", ref: String(person._id), refKind: "teacher" };
  },
  async subject(d) {
    const s = await Subject.findOne({ name: d.name });
    if (s) return { status: "found", ref: String(s._id), refKind: "subject" };
    await assertCategoryKey(d.category);
    const made = await Subject.create({ name: d.name, category: d.category });
    return { status: "made", ref: String(made._id), refKind: "subject" };
  },
  async student(d, refs, by) {
    const { person, many, byId } = await findStudent(d);
    if (many) throw AppError.of("ACTION_STEP", 409, "יש במערכת יותר מאדם אחד בשם הזה");
    // whoever is opened here is opened to be seated: one step before the seat, which then places them
    const opts = { pipelineInit: { stage: "AwaitingPlacement", movedBy: by, note: "נפתח בפעולה מוכנה" }, opened: { by, note: "נפתח בפעולה מוכנה" } };
    if (!person) {
      if (byId) throw AppError.of("ACTION_STEP", 404, "האדם הזה כבר לא נמצא במערכת");
      const phone = normalizePhone(d.phone);
      const made = await createPersonWithProfile("StudentCollege", { firstName: d.firstName, ...(d.lastName && { lastName: d.lastName }), ...(phone && { phone }) }, opts);
      return { status: "made", ref: String(made.person._id), refKind: "student" };
    }
    if (await tags.holds(person._id, "college")) return { status: "found", ref: String(person._id), refKind: "student" };
    await createProfile(person, "StudentCollege", {}, opts);
    return { status: "made", ref: String(person._id), refKind: "student", message: "האדם כבר היה במערכת. נפתחה מכללה לכל, ושאר הפרטים לא השתנו" };
  },
  async cycle(d, refs) {
    const subject = must(d.subject, refs);
    const teacher = d.teacher ? must(d.teacher, refs) : null;
    const was = await findCycle(d, subject, teacher);
    if (was) return { status: "found", ref: String(was._id), refKind: "cycle" };
    const missing = [];
    const schedule = [];
    for (const s of d.schedule) {
      const room = s.room ? await Room.findOne({ name: s.room }) : null;
      if (s.room && !room) missing.push(s.room);
      schedule.push({ day: s.day, start: s.start, end: s.end, room: room ? room._id : null });
    }
    const made = await Cycle.create({
      subject,
      teacher,
      status: "Active",
      startDate: new Date(d.startDate),
      endDate: new Date(d.endDate),
      schedule,
      matching: { format: d.format, enrollmentOpen: true, ...(d.capacity && { capacity: d.capacity }) },
      ...((d.senzeyCourseId || d.senzeyName) && { import: { ...(d.senzeyCourseId && { senzeyCourseId: d.senzeyCourseId }), ...(d.senzeyName && { senzeyName: d.senzeyName }), ...(missing.length && { roomLabel: missing.join(", ") }) } }),
    });
    return { status: "made", ref: String(made._id), refKind: "cycle", message: missing.length ? `נוצר בלי חדר: אין במערכת חדר בשם ${missing.join(", ")}` : "" };
  },
  async seat(d, refs, by) {
    const student = must(d.student, refs);
    const cycle = must(d.cycle, refs);
    const was = await Enrollment.findOne({ cycle, student, status: { $in: ["reserved", "active"] } });
    if (was && was.status === "active") return { status: "found", ref: String(cycle), refKind: "cycle" };
    await enroll({ cycleId: cycle, studentId: student, status: "active", createdBy: by, note: "שובץ בפעולה מוכנה" });
    return { status: "made", ref: String(cycle), refKind: "cycle" };
  },
};

/* ───────── the service ───────── */

async function list() {
  const rows = await PreparedAction.find().sort({ createdAt: -1 }).limit(200);
  const order = { running: 0, partial: 1, ready: 2, done: 3, cancelled: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status]);
  const out = [];
  for (const r of rows) out.push(await forPage(r));
  return out;
}

const waitingCount = () => PreparedAction.countDocuments({ status: { $in: WAITING } });

async function create(body, by = "") {
  const doc = await PreparedAction.create({ ...cleanAction(body), createdBy: by });
  return forPage(doc);
}

/** Write a waiting action again, whole (its facts or its words were corrected before he approved). One that ran is not touched. */
async function rewrite(id, body, by = "") {
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "פעולה");
  const doc = await PreparedAction.findOneAndUpdate({ _id: id, status: "ready" }, { $set: { ...cleanAction(body), createdBy: by } }, { new: true });
  if (!doc) throw AppError.of("ACTION_NOT_READY", 409);
  return forPage(doc);
}

async function cancel(id) {
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "פעולה");
  const doc = await PreparedAction.findOneAndUpdate({ _id: id, status: "ready" }, { $set: { status: "cancelled", finishedAt: new Date() } }, { new: true });
  if (!doc) throw AppError.of("ACTION_NOT_READY", 409);
  return forPage(doc);
}

/**
 * Run an action: `skip` = the optional steps he took the tick off. The status is flipped in ONE write, so two
 * presses cannot run it twice. Every step keeps its outcome as it ends; a failure does not stop the rest.
 */
async function approve(id, { skip = [], by = "" } = {}) {
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "פעולה");
  const doc = await PreparedAction.findOneAndUpdate({ _id: id, status: { $in: WAITING } }, { $set: { status: "running", approvedBy: by, approvedAt: new Date() } }, { new: true });
  if (!doc) throw AppError.of("ACTION_NOT_READY", 409);
  const off = new Set((Array.isArray(skip) ? skip : []).map(String));
  const refs = new Map();
  // what he chose to leave out, and whatever leans on it: left out by his word, so the action is still whole without it
  const gone = new Set();
  try {
    for (const step of doc.steps) {
      const was = step.outcome?.status;
      if (was === "made" || was === "found") {
        if (step.kind !== "seat") refs.set(step.id, step.outcome.ref);
        continue;
      }
      let outcome;
      if (step.optional && off.has(step.id)) {
        outcome = { status: "skipped", message: "הוצא מהפעולה לפני האישור" };
        gone.add(step.id);
      } else if (needsOf(step).some((n) => gone.has(n))) {
        outcome = { status: "skipped", message: "תלוי בצעד שהוצא מהפעולה" };
        gone.add(step.id);
      } else {
        try {
          outcome = await DO[step.kind](step.data, refs, by);
          if (step.kind !== "seat") refs.set(step.id, outcome.ref);
        } catch (e) {
          if (e instanceof Leaning) outcome = { status: "skipped", message: "תלוי בצעד שלא בוצע" };
          else outcome = { status: "failed", message: text(e?.isOperational ? e.message : e?.message || "שגיאה", 380) };
        }
      }
      step.outcome = { status: outcome.status, ref: outcome.ref || "", refKind: outcome.refKind || "", message: outcome.message || "", at: new Date() };
      await doc.save();
    }
  } finally {
    // whatever happened, the action never stays "running"
    const left = doc.steps.some((s) => s.outcome?.status === "failed" || (s.outcome?.status === "skipped" && !gone.has(s.id)) || !s.outcome?.status);
    doc.status = left ? "partial" : "done";
    doc.finishedAt = new Date();
    await doc.save();
  }
  return forPage(doc);
}

module.exports = { list, waitingCount, create, rewrite, cancel, approve, cleanAction };
