/**
 * @file Putting the students and the courses in order - the college's staff with the super admin
 * @module services/orderService
 *
 * Eden (2026-11-25): "תיצור לי ולנעה וחגיי עמוד שבו אנחנו נעשה סדר עם
 * הסטודנטים. …רשימה של כל הסטודנטים גם במערכת וגם בסנזיי. יהיה להם (רק לעמוד
 * הזה) תג של 'מערכת' 'סנזיי' או שניהם… לכל רשומה יהיו פעולות של - שייך למכללה
 * לכל, עזב את שקל, אחר… כמו כן יהיה עמוד שמרכז את כל הקורסים… לפי לוח שנה עם
 * פילטר של מורים… אפשר לערוך מי בקורס. יהיה אפשר גם למחוק את הקורס… חשוב לי גם
 * שכל השינויים יתועדו אצלי שאני אדע מה המצב הישן שהיה ומה המצב החדש". And the
 * same day: "אם מורה קיים לו קורס בלי סטודנטים אז בשביל זה צריך לעשות גם
 * זמינות של מורה אצלם שיערכו".
 *
 * ONE READ (`board`) gives the two pages everything:
 *   rows      a line per person OF מכללה לכל - ours, the old system's, or both
 *             when the two are one person (utils/nameCross; the ID numbers and the
 *             phones are compared HERE and are never in the answer)
 *   courses   the courses that run today, each with whoever sits in it
 *   teachers  the teachers and the hours each is free
 *
 * THE WRITES - each through the app's own way, each written to the journal
 * (models/OrderLog) with what was before and what is after:
 *   mark       a word about a person: belongs to the college / left / other.
 *              A WORD only - nothing of the person's record changes by it.
 *   link       two lines that look alike are one person, or are two
 *   seatOff    a person leaves a course (enrollmentService: the seat is
 *              kept as "left", the college stage moves by the app's rule)
 *   seatOn     a person takes a seat in a course (enrollmentService.enroll)
 *   courseOff  a course goes: deleted outright with its seats when nothing
 *              else leans on it; CLOSED (it ended yesterday, cancelled) when
 *              attendance, an invoice or a waiting list still point at it.
 *              `toWindow`: its hours become hours the teacher is free.
 *   windows    the hours a teacher is free (the rules of the teacher's page)
 *
 * The pages are the college's: a hostel's course is never deleted from here,
 * and a college manager meets no hostel course at all (services/lensService).
 */

const mongoose = require("mongoose");
const AppSetting = require("../models/AppSetting");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const CycleTag = require("../models/CycleTag");
const { PersonTag } = require("../models/PersonTag");
const WaitEntry = require("../models/WaitEntry");
const InvoiceRequest = require("../models/InvoiceRequest");
const OrderMark = require("../models/OrderMark");
const OrderLog = require("../models/OrderLog");
const tags = require("./tagService");
const lens = require("./lensService");
const { enroll, updateStatus } = require("./enrollmentService");
const AppError = require("../utils/AppError");
const { whoAmI } = require("../utils/actor");
const { crossCheck, nameKey } = require("../utils/nameCross");
const { OCCUPYING_STATUSES, PIPELINE_STAGES } = require("../utils/domain");

const { ORDER_DECISIONS } = OrderMark;
const PROGRAM_KEYS = ["college", "culture", "hostels"];
const WINDOW_PROGRAMS = ["college", "hostels"];
const DECISION_HE = { college: "שייך/ת למכללה לכל", left: "עזב/ה את שק״ל", other: "אחר" };
const PROGRAM_HE = { college: "מכללה לכל", hostels: "הוסטלים" };
const DAY_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const SEAT_HE = { active: "שיבוץ פעיל", reserved: "מקום שמור", left: "שיבוץ שהסתיים", completed: "שיבוץ שהושלם" };

const isId = (v) => typeof v === "string" && mongoose.isValidObjectId(v) && /^[0-9a-f]{24}$/i.test(v);
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const fullName = (p) => `${p?.firstName || ""} ${p?.lastName || ""}`.trim();
const stageHe = (key) => PIPELINE_STAGES.find((s) => s.key === key)?.label || "";
const stageLine = (key) => (key ? `השלב במכללה לכל: ${stageHe(key)}` : "בלי שלב במכללה לכל");
const dayStr = (d) => (d ? new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d)) : "");
/** The first moment of today in Israel, as the dates of the courses are kept (UTC midnight). */
const startOfToday = () => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date())}T00:00:00.000Z`);
const slotWords = (s) => `יום ${DAY_HE[s.day] || "?"} ${s.start}-${s.end}`;
const windowWords = (w) => `${slotWords(w)}${w.program ? ` · ${PROGRAM_HE[w.program]}` : ""}`;
const byDayHour = (a, b) => a.day - b.day || String(a.start).localeCompare(String(b.start));
const windowLines = (list) => (list.length ? [...list].sort(byDayHour).map(windowWords) : ["לא סומנו שעות פנויות"]);
const plainWindow = (w) => ({ day: w.day, start: w.start, end: w.end, program: WINDOW_PROGRAMS.includes(w.program) ? w.program : null });

const CYCLE_POP = [
  { path: "subject", select: "name category" },
  { path: "teacher", select: "firstName lastName" },
  { path: "hostel", select: "name" },
  { path: "schedule.room", select: "name" },
];
const courseName = (c) => c?.subject?.name || "קורס";
/** A course in one line: what, who teaches, when. */
const courseWords = (c) => [courseName(c), c.teacher ? `המורה ${fullName(c.teacher)}` : "בלי מורה", (c.schedule || []).map(slotWords).join(", ")].filter(Boolean).join(" · ");

/** Who signs a change: the acting account - and, when the super admin acts while viewing as someone, both names. */
function signer(req) {
  const me = whoAmI(req);
  const own = req?.account?.name || "";
  return { by: own && me.name && own !== me.name ? `${own} (בתור ${me.name})` : me.name || own, byAccount: me.accountId };
}

/** One line of the journal. */
function writeLog(req, entry) {
  return OrderLog.create({ at: new Date(), ...signer(req), ...entry });
}

const stageOf = async (personId) => (await Profile.findOne({ person: personId, kind: "StudentCollege", active: true }).select("pipeline.stage").lean())?.pipeline?.stage || null;

/* ───────────────────────── the old system's lists ───────────────────────── */

const rowsOf = async (key) => (await AppSetting.findOne({ key }).lean())?.value?.rows || [];
const parseDay = (v) => {
  const m = String(v || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12).getTime() : null;
};

/** Is a course of the old system one of מכללה לכל? (Not a hostel's, a branch's, the gym's or the club's - client lib/courseCross `programOfCourse`.) */
function oldCourseOfCollege(c) {
  const name = String(c?.name || "");
  const kind = String(c?.category || "");
  const branch = String(c?.branch || "");
  if (/חדר כושר|מועדון חברתי|מזרח ירושלים|מעלה אדומים/.test(name) || /מזרח ירושלים/.test(branch) || /מעלה אדומים/.test(kind)) return false;
  if (/הוסטלים/.test(kind) || /^הוסטל/.test(branch)) return false;
  // a list with no kinds at all (an older picture of the list) is taken as it is
  return /מכללה לכל/.test(kind) || /מכללה לכל/.test(name) || (!kind && !branch);
}

/**
 * What the old system holds of each of its students TODAY, in מכללה לכל: the courses that still run there in which the person
 * holds a registration whose own last day has not passed (its "active" flags say nothing - the days do). The lists of
 * people who only asked ("מתעניין/ת ב…") are not courses. → Map(rid → [{ name, weekday, time }])
 */
async function oldCoursesByStudent(oldRows) {
  const [courses, seats] = await Promise.all([rowsOf("oldCourses"), rowsOf("oldSeats")]);
  const out = new Map();
  if (!courses.length || !seats.length) return out;
  const now = new Date();
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
  const passed = (v) => {
    const t = parseDay(v);
    return t != null && t < noon;
  };
  const running = new Map();
  for (const c of courses) {
    if (c.status && c.status !== "פעיל") continue;
    if (passed(c.finish) || /^מתעניי/.test(String(c.name || "").trim()) || !oldCourseOfCollege(c)) continue;
    running.set(String(c.rid), c);
  }
  const byNumber = new Map(oldRows.filter((r) => r.idNumber).map((r) => [r.idNumber, String(r.rid)]));
  const names = new Map();
  for (const r of oldRows) names.set(nameKey(r.name), [...(names.get(nameKey(r.name)) || []), String(r.rid)]);
  for (const s of seats) {
    const course = running.get(String(s.course));
    if (!course || passed(s.until)) continue;
    const sameName = names.get(nameKey(s.name)) || [];
    const rid = (s.idNumber && byNumber.get(s.idNumber)) || (sameName.length === 1 ? sameName[0] : null);
    if (!rid) continue;
    const list = out.get(rid) || out.set(rid, []).get(rid);
    if (list.some((x) => x.rid === String(course.rid)) || list.length >= 40) continue;
    list.push({ rid: String(course.rid), name: course.name, weekday: s.weekday || "", time: [s.time, s.timeEnd].filter(Boolean).join("-") });
  }
  return out;
}

/* ───────────────────────── the read ───────────────────────── */

/**
 * Everything the two pages show:
 *   { rows, courses, teachers, old: { takenAt, count } | null }
 *   row      { key, person | null, old | null, how, maybe | null, mark | null }
 *            person { _id, firstName, lastName, gender, tags, former, stage, inLens }
 *            old    { rid, name, type, status, residence, frame, courses: [{ name, weekday, time }] }
 *            how    why the two are one person: id · phone · name · link (the staff said so)
 *            maybe  a line that only LOOKS like this one: { key, name, why } - for a person to decide
 *   course   { _id, name, category, teacher: { _id, name } | null, hostel: name | null, slots: [{ day, start, end, room }],
 *              startDate, endDate, capacity, leans (what still points at it), seats: [{ id, student, name, status, joinedAt }] }
 *   teacher  { _id, name, windows: [{ day, start, end, program }] }
 */
async function board(req) {
  const view = lens.lensOf(req.actor);
  const today = startOfToday();

  /* our people: whoever is, or once was, a student of one of the three programs */
  const map = await tags.tagMap();
  const tagIds = ["student", ...PROGRAM_KEYS].map((k) => map.get(k)?._id).filter(Boolean);
  const ids = tagIds.length ? await PersonTag.distinct("person", { tag: { $in: tagIds } }) : [];
  const [people, tagsOf, profiles] = await Promise.all([
    Person.find({ _id: { $in: ids }, deletedAt: null }).select("firstName lastName phone gender").lean(),
    tags.tagsByPerson(ids),
    Profile.find({ kind: "StudentCollege", active: true, person: { $in: ids } }).select("person pipeline.stage").lean(),
  ]);
  const stageBy = new Map(profiles.map((p) => [String(p.person), p.pipeline?.stage || null]));
  const personOut = (p) => {
    const t = tagsOf.get(String(p._id)) || { tags: [], pastTags: [] };
    const programs = [...PROGRAM_KEYS, "gym"].filter((k) => t.tags.includes(k));
    return {
      _id: String(p._id),
      firstName: p.firstName || "",
      lastName: p.lastName || "",
      gender: p.gender || null,
      tags: programs,
      former: !PROGRAM_KEYS.some((k) => t.tags.includes(k)),
      stage: stageBy.get(String(p._id)) || null,
      // may this persona open the person's card? (a college manager: whoever is, or was, of the college)
      inLens: view.all || [...t.tags, ...t.pastTags].includes("college"),
    };
  };

  /* the old system's students, and who of them is who of ours */
  const oldSetting = await AppSetting.findOne({ key: "oldStudents" }).lean();
  const oldRows = oldSetting?.value?.rows || [];
  const numbers = [...new Set(oldRows.map((r) => r.idNumber).filter(Boolean))];
  const numbered = numbers.length ? await Person.find({ idNumber: { $in: numbers } }).select("+idNumber").lean() : [];
  const personByNumber = new Map(numbered.map((p) => [p.idNumber, String(p._id)]));
  const oldCourses = await oldCoursesByStudent(oldRows);
  const oldOut = (r) => ({ rid: String(r.rid), name: r.name, type: r.type || "", status: r.status || "", residence: r.residence || "", frame: r.frame || "", courses: (oldCourses.get(String(r.rid)) || []).map(({ name, weekday, time }) => ({ name, weekday, time })) });
  // THE LIST IS THE COLLEGE'S ALONE (Eden, 2026-11-25, shown every student of שק״ל: "אמרתי לך רק מבין מי שמכללה
  // לכל!!!!"). A line stays when the person holds מכללה לכל with us, or when the old system puts the person in it:
  // its status names מכללה לכל, or it holds a registration in force to a college course that runs there today.
  const oldOfCollege = (r) => /מכללה לכל/.test(String(r.status || "")) || (oldCourses.get(String(r.rid)) || []).length > 0;
  const oursOfCollege = (p) => (tagsOf.get(String(p._id))?.tags || []).includes("college");

  const marks = await OrderMark.find().lean();
  const markBy = new Map(marks.filter((m) => m.decision).map((m) => [m.key, { decision: m.decision, note: m.note || "", by: m.by || "", at: m.at || m.updatedAt || null }]));
  const links = marks.filter((m) => m.key.startsWith("l:") && m.same !== null);
  const peopleById = new Map(people.map((p) => [String(p._id), p]));
  const oldByRid = new Map(oldRows.map((r) => [String(r.rid), r]));

  // what the staff already said: these two are one person / are two
  const said = [];
  const apart = new Set();
  const usedP = new Set();
  const usedR = new Set();
  for (const l of links) {
    const p = peopleById.get(String(l.person));
    const r = oldByRid.get(String(l.rid));
    if (!p || !r) continue;
    if (l.same === false) apart.add(`${l.rid}|${l.person}`);
    else if (!usedP.has(String(p._id)) && !usedR.has(String(r.rid))) {
      usedP.add(String(p._id));
      usedR.add(String(r.rid));
      said.push({ row: r, person: p, how: "link" });
    }
  }
  const cross = crossCheck(
    oldRows.filter((r) => !usedR.has(String(r.rid))).map((r) => ({ ...r, idPerson: (r.idNumber && personByNumber.get(r.idNumber)) || null })),
    people.filter((p) => !usedP.has(String(p._id)))
  );

  const rows = [];
  const markOf = (person, rid) => (person && markBy.get(`p:${person._id}`)) || (rid && markBy.get(`s:${rid}`)) || null;
  for (const { row, person, how } of [...said, ...cross.pairs]) rows.push({ key: `p:${person._id}`, person: personOut(person), old: oldOut(row), how, maybe: null, mark: markOf(person, row.rid) });
  for (const { row, person, why } of cross.check) {
    const two = apart.has(`${row.rid}|${person._id}`);
    rows.push({ key: `p:${person._id}`, person: personOut(person), old: null, how: "", maybe: two ? null : { key: `s:${row.rid}`, name: row.name, why }, mark: markOf(person, null) });
    rows.push({ key: `s:${row.rid}`, person: null, old: oldOut(row), how: "", maybe: two ? null : { key: `p:${person._id}`, name: fullName(person), why }, mark: markOf(null, row.rid) });
  }
  for (const person of cross.onlyOurs) rows.push({ key: `p:${person._id}`, person: personOut(person), old: null, how: "", maybe: null, mark: markOf(person, null) });
  for (const row of cross.onlyOld) rows.push({ key: `s:${row.rid}`, person: null, old: oldOut(row), how: "", maybe: null, mark: markOf(null, row.rid) });
  // the cross is made over everyone (so that a person is matched to the right row), and only then the college's lines are kept
  const mine = (r) => Boolean((r.person && oursOfCollege(r.person)) || (r.old && oldOfCollege(oldByRid.get(r.old.rid))));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const kept = rows.filter((r) => mine(r) || (r.maybe && byKey.has(r.maybe.key) && mine(byKey.get(r.maybe.key))));

  /* the courses that run today, with their seats */
  const cond = lens.cycleCond(view);
  const cycles = await Cycle.find({ status: "Active", endDate: { $gte: today }, ...(cond || {}) }).populate(CYCLE_POP).lean();
  const cycleIds = cycles.map((c) => c._id);
  const [seats, lessons, waits, invoices] = await Promise.all([
    Enrollment.find({ cycle: { $in: cycleIds }, status: { $in: OCCUPYING_STATUSES } }).select("cycle student status joinedAt").lean(),
    Lesson.aggregate([{ $match: { cycle: { $in: cycleIds } } }, { $group: { _id: "$cycle", n: { $sum: 1 } } }]),
    WaitEntry.aggregate([{ $match: { course: { $in: cycleIds } } }, { $group: { _id: "$course", n: { $sum: 1 } } }]),
    InvoiceRequest.aggregate([{ $unwind: "$sessions" }, { $match: { "sessions.cycle": { $in: cycleIds } } }, { $group: { _id: "$sessions.cycle", n: { $sum: 1 } } }]),
  ]);
  const countBy = (list) => new Map(list.map((x) => [String(x._id), x.n]));
  const [lessonsBy, waitsBy, invoicesBy] = [countBy(lessons), countBy(waits), countBy(invoices)];
  // a seat's person who is not on the list above (a teacher who also learns, a person with no student tag)
  const strangers = [...new Set(seats.map((s) => String(s.student)).filter((id) => !peopleById.has(id)))];
  const extra = strangers.length ? await Person.find({ _id: { $in: strangers } }).select("firstName lastName").lean() : [];
  const nameById = new Map([...people, ...extra].map((p) => [String(p._id), fullName(p)]));
  const seatsBy = new Map();
  for (const s of seats) {
    const k = String(s.cycle);
    seatsBy.set(k, [...(seatsBy.get(k) || []), { id: String(s._id), student: String(s.student), name: nameById.get(String(s.student)) || "", status: s.status, joinedAt: s.joinedAt || null }]);
  }
  const courses = cycles.map((c) => ({
    _id: String(c._id),
    name: courseName(c),
    category: c.subject?.category || "",
    teacher: c.teacher ? { _id: String(c.teacher._id), name: fullName(c.teacher) } : null,
    hostel: c.hostel?.name || null,
    slots: (c.schedule || []).map((s) => ({ day: s.day, start: s.start, end: s.end, room: s.room?.name || c.import?.roomLabel || "" })).sort(byDayHour),
    startDate: c.startDate,
    endDate: c.endDate,
    capacity: c.matching?.capacity ?? null,
    leans: { lessons: lessonsBy.get(String(c._id)) || 0, waits: waitsBy.get(String(c._id)) || 0, invoices: invoicesBy.get(String(c._id)) || 0 },
    seats: (seatsBy.get(String(c._id)) || []).sort((a, b) => a.name.localeCompare(b.name, "he")),
  }));

  /* the teachers and the hours each is free */
  const teacherIds = await Profile.find({ kind: "Teacher", active: true }).distinct("person");
  const teacherRows = await Person.find({ _id: { $in: teacherIds }, deletedAt: null }).select("firstName lastName availability").lean();
  const teachers = teacherRows
    .map((t) => ({ _id: String(t._id), name: fullName(t), windows: (t.availability || []).map(plainWindow).sort(byDayHour) }))
    .sort((a, b) => a.name.localeCompare(b.name, "he"));

  return { rows: kept, courses, teachers, old: oldSetting ? { takenAt: oldSetting.value?.takenAt || null, count: oldRows.length } : null };
}

/* ───────────────────────── a word about a person ───────────────────────── */

/** Whom a key names: { person, rid, name } - or a 404 when there is no such line. */
async function lineOf(key) {
  const p = /^p:([0-9a-f]{24})$/i.exec(String(key || ""));
  if (p) {
    const person = await Person.findOne({ _id: p[1], deletedAt: null }).select("firstName lastName").lean();
    if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
    return { person: person._id, rid: "", name: fullName(person) };
  }
  const s = /^s:(.{1,20})$/.exec(String(key || ""));
  if (s) {
    const row = (await rowsOf("oldStudents")).find((r) => String(r.rid) === s[1]);
    if (!row) throw AppError.of("NOT_FOUND", 404, "שורה ברשימה");
    return { person: null, rid: String(row.rid), name: row.name };
  }
  throw AppError.of("ORDER_INVALID", 400);
}

const markLines = (m) => (m?.decision ? [`סימון: ${DECISION_HE[m.decision]}`, ...(m.note ? [`ההערה: ${m.note}`] : [])] : ["בלי סימון"]);

/** POST …/marks { key, decision: college | left | other | null, note } - null takes the word back. */
async function mark(req) {
  const { key } = req.body || {};
  const decision = req.body?.decision ?? null;
  if (decision !== null && !ORDER_DECISIONS.includes(decision)) throw AppError.of("ORDER_INVALID", 400);
  const note = decision === "other" ? text(req.body?.note, 800) : "";
  if (decision === "other" && !note) throw AppError.of("ORDER_NOTE_NEEDED", 400);
  const line = await lineOf(key);
  const k = line.person ? `p:${line.person}` : `s:${line.rid}`;
  const before = await OrderMark.findOne({ key: k }).lean();
  const same = (before?.decision || null) === decision && (before?.note || "") === note;
  if (same) return { mark: decision ? { decision, note, by: before.by, at: before.at } : null };
  const { by } = signer(req);
  const at = new Date();
  await OrderMark.findOneAndUpdate({ key: k }, { $set: { person: line.person, rid: line.rid, name: line.name, decision, note, by, at } }, { upsert: true });
  await writeLog(req, {
    kind: "mark",
    person: line.person,
    rid: line.rid,
    personName: line.name,
    text: decision ? `סימון: ${DECISION_HE[decision]}` : "הסימון הוסר",
    before: markLines(before),
    after: markLines({ decision, note }),
    raw: { before: before ? { decision: before.decision, note: before.note, by: before.by, at: before.at } : null, after: { decision, note } },
  });
  return { mark: decision ? { decision, note, by, at } : null };
}

/** POST …/links { rid, person, same: true | false | null } - a row of the old list and a person of ours are one, or two. */
async function link(req) {
  const { rid, person } = req.body || {};
  const same = req.body?.same ?? null;
  if (!isId(person) || !text(String(rid ?? ""), 20) || ![true, false, null].includes(same)) throw AppError.of("ORDER_INVALID", 400);
  const [ours, old] = await Promise.all([lineOf(`p:${person}`), lineOf(`s:${rid}`)]);
  const key = `l:${old.rid}:${person}`;
  const before = await OrderMark.findOne({ key }).lean();
  if ((before?.same ?? null) === same) return { same };
  const { by } = signer(req);
  await OrderMark.findOneAndUpdate({ key }, { $set: { person: ours.person, rid: old.rid, name: ours.name, same, by, at: new Date() } }, { upsert: true });
  const words = (v) => (v === true ? "אותו אדם" : v === false ? "שני אנשים" : "לא נאמר");
  await writeLog(req, {
    kind: "link",
    person: ours.person,
    rid: old.rid,
    personName: ours.name,
    text: `${ours.name} במערכת ו${old.name} בסנזיי: ${words(same)}`,
    before: [words(before?.same ?? null)],
    after: [words(same)],
    raw: { before: before?.same ?? null, after: same },
  });
  return { same };
}

/* ───────────────────────── seats ───────────────────────── */

/** POST …/seats/off { enrollment } - the person leaves the course; the seat stays in the records as one that ended. */
async function seatOff(req) {
  const id = req.body?.enrollment;
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "שיבוץ");
  const seat = await Enrollment.findById(id).lean();
  if (!seat) throw AppError.of("NOT_FOUND", 404, "שיבוץ");
  await lens.assertCycle(req, String(seat.cycle));
  if (!OCCUPYING_STATUSES.includes(seat.status)) throw AppError.of("ORDER_SEAT_GONE", 409);
  const [cycle, person, stageBefore] = await Promise.all([Cycle.findById(seat.cycle).populate(CYCLE_POP).lean(), Person.findById(seat.student).select("firstName lastName").lean(), stageOf(seat.student)]);
  const { by } = signer(req);
  await updateStatus({ enrollmentId: id, status: "left", movedBy: by });
  const stageAfter = await stageOf(seat.student);
  await writeLog(req, {
    kind: "seatOff",
    person: seat.student,
    personName: fullName(person),
    cycle: seat.cycle,
    cycleName: courseName(cycle),
    text: `ירידה מהקורס ${courseName(cycle)}`,
    before: [`${SEAT_HE[seat.status]} בקורס: ${courseWords(cycle)}`, ...(seat.joinedAt ? [`בקורס מאז ${dayStr(seat.joinedAt)}`] : []), stageLine(stageBefore)],
    after: [`לא בקורס הזה, מ־${dayStr(new Date())}`, stageLine(stageAfter)],
    raw: { enrollment: seat, stageBefore, stageAfter },
  });
  return { seat: { id, status: "left" }, student: String(seat.student), stage: stageAfter };
}

/** POST …/seats/on { cycle, student } - the person takes a seat in the course (and one who left it comes back). */
async function seatOn(req) {
  const { cycle: cycleId, student } = req.body || {};
  if (!isId(cycleId)) throw AppError.of("NOT_FOUND", 404, "מחזור");
  if (!isId(student)) throw AppError.of("NOT_FOUND", 404, "סטודנט");
  await lens.assertCycle(req, cycleId);
  const [cycle, person, was, stageBefore] = await Promise.all([Cycle.findById(cycleId).populate(CYCLE_POP).lean(), Person.findById(student).select("firstName lastName").lean(), Enrollment.findOne({ cycle: cycleId, student }).lean(), stageOf(student)]);
  if (!cycle) throw AppError.of("NOT_FOUND", 404, "מחזור");
  const { by } = signer(req);
  const saved = await enroll({ cycleId, studentId: student, status: "active", createdBy: by, note: "שיבוץ מעמוד הסדר" });
  const stageAfter = await stageOf(student);
  await writeLog(req, {
    kind: "seatOn",
    person: student,
    personName: fullName(person),
    cycle: cycleId,
    cycleName: courseName(cycle),
    text: `שיבוץ לקורס ${courseName(cycle)}`,
    before: [was ? `${SEAT_HE[was.status]} בקורס הזה` : "לא בקורס הזה", stageLine(stageBefore)],
    after: [`שיבוץ פעיל בקורס: ${courseWords(cycle)}`, stageLine(stageAfter)],
    raw: { before: was || null, after: { enrollment: String(saved._id), status: saved.status }, stageBefore, stageAfter },
  });
  return { seat: { id: String(saved._id), student: String(student), name: fullName(person), status: saved.status, joinedAt: saved.joinedAt || null }, cycle: String(cycleId), stage: stageAfter };
}

/* ───────────────────────── a teacher's free hours ───────────────────────── */

const toMin = (t) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return h * 60 + (m || 0);
};
const overlap = (a, b) => a.day === b.day && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

/** A teacher of ours, or a 404. */
async function teacherDoc(id) {
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "מורה");
  const [person, teaches] = await Promise.all([Person.findOne({ _id: id, deletedAt: null }), Profile.exists({ person: id, kind: "Teacher" })]);
  if (!person || !teaches) throw AppError.of("NOT_FOUND", 404, "מורה");
  return person;
}

/** PUT …/teachers/:id/windows { availability: [{ day, start, end, program }] } - the whole list, by the teacher page's rules. */
async function windows(req) {
  if (!Array.isArray(req.body?.availability) || req.body.availability.length > 60) throw AppError.of("ORDER_INVALID", 400);
  const person = await teacherDoc(req.params.id);
  const incoming = req.body.availability.map(plainWindow);
  const existing = (person.availability || []).map(plainWindow);
  // the rules of program-marked windows live with the teacher's own route
  const err = require("../controllers/personController").checkAvailability(incoming, existing, req.actor);
  if (err) throw err;
  person.availability = incoming;
  await person.save();
  const key = (list) => windowLines(list).join("|");
  if (key(existing) !== key(incoming)) {
    await writeLog(req, {
      kind: "windows",
      person: person._id,
      personName: fullName(person),
      text: `השעות הפנויות של ${fullName(person)}`,
      before: windowLines(existing),
      after: windowLines(incoming),
      raw: { before: existing, after: incoming },
    });
  }
  return { teacher: String(person._id), windows: incoming.sort(byDayHour) };
}

/**
 * A course's hours become hours its teacher is free for the college. An hour the teacher already marked free stays
 * as it is; an hour kept for the hostels is not touched. → { windows, lines: what happened, in words }
 */
async function hoursToWindows(teacherId, slots) {
  const person = await Person.findOne({ _id: teacherId, deletedAt: null });
  if (!person) return { windows: null, lines: ["המורה לא נמצא/ה, השעות לא סומנו כפנויות"] };
  const list = (person.availability || []).map(plainWindow);
  const lines = [];
  for (const s of slots) {
    const w = { day: s.day, start: s.start, end: s.end, program: "college" };
    if (list.some((x) => x.program === "hostels" && overlap(x, w))) {
      lines.push(`${slotWords(w)}: לא סומן, השעה שמורה להוסטלים`);
      continue;
    }
    if (list.some((x) => x.program !== "hostels" && x.day === w.day && toMin(x.start) <= toMin(w.start) && toMin(x.end) >= toMin(w.end))) {
      lines.push(`${slotWords(w)}: כבר סומן כזמן פנוי`);
      continue;
    }
    // the new window swallows what it touches of the college's own windows on that day
    const touching = list.filter((x) => x.program === "college" && x.day === w.day && toMin(x.start) <= toMin(w.end) && toMin(w.start) <= toMin(x.end));
    for (const x of touching) {
      if (toMin(x.start) < toMin(w.start)) w.start = x.start;
      if (toMin(x.end) > toMin(w.end)) w.end = x.end;
      list.splice(list.indexOf(x), 1);
    }
    list.push(w);
    lines.push(`${slotWords(w)}: סומן כזמן פנוי למכללה לכל`);
  }
  person.availability = list;
  await person.save();
  return { windows: list.sort(byDayHour), lines };
}

/* ───────────────────────── a course goes ───────────────────────── */

/**
 * DELETE …/courses/:id { toWindow } - the course leaves the board. Whoever sits in it leaves it first, by the app's
 * own rule (a placed student with no other course goes back to "דרוש שיבוץ מחדש"). Then:
 *   nothing else points at it   it is deleted, with its seats - the journal keeps all of it as it was
 *   attendance / an invoice / a waiting list point at it   it is CLOSED: cancelled, ended yesterday; nothing is lost
 */
async function courseOff(req) {
  const id = req.params.id;
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "מחזור");
  await lens.assertCycle(req, id);
  const cycle = await Cycle.findById(id).populate(CYCLE_POP).lean();
  if (!cycle) throw AppError.of("NOT_FOUND", 404, "מחזור");
  if (cycle.hostel) throw AppError.of("ORDER_COLLEGE_ONLY", 400);
  const [rawCycle, rawSeats, rawTags, lessons, waits, invoices] = await Promise.all([
    Cycle.findById(id).lean(),
    Enrollment.find({ cycle: id }).lean(),
    CycleTag.find({ cycle: id }).lean(),
    Lesson.countDocuments({ cycle: id }),
    WaitEntry.countDocuments({ course: id }),
    InvoiceRequest.countDocuments({ "sessions.cycle": id }),
  ]);
  const keep = lessons + waits + invoices > 0;
  const sitting = rawSeats.filter((s) => OCCUPYING_STATUSES.includes(s.status));
  const names = new Map((await Person.find({ _id: { $in: rawSeats.map((s) => s.student) } }).select("firstName lastName").lean()).map((p) => [String(p._id), fullName(p)]));
  const { by } = signer(req);

  const moves = [];
  for (const s of sitting) {
    const was = await stageOf(s.student);
    await updateStatus({ enrollmentId: String(s._id), status: "left", movedBy: by });
    const now = await stageOf(s.student);
    if (was !== now) moves.push({ student: String(s.student), name: names.get(String(s.student)) || "", from: was, to: now });
  }

  let window = null;
  if (req.body?.toWindow && cycle.teacher && (cycle.schedule || []).length) window = await hoursToWindows(cycle.teacher._id, cycle.schedule);

  if (keep) {
    const yesterday = new Date(startOfToday().getTime() - 24 * 60 * 60 * 1000);
    // straight to the row: the course's other fields are not judged again on the way out
    await Cycle.updateOne({ _id: id }, { $set: { status: "Cancelled", endDate: yesterday, ...(new Date(cycle.startDate) > yesterday && { startDate: yesterday }) } });
  } else {
    await Enrollment.deleteMany({ cycle: id });
    await CycleTag.deleteMany({ cycle: id });
    await Cycle.deleteOne({ _id: id });
  }

  const leaning = [lessons && `${lessons} דיווחי שיעור`, invoices && `${invoices} בקשות חשבונית`, waits && `${waits} שורות ברשימת המתנה`].filter(Boolean);
  await writeLog(req, {
    kind: "courseOff",
    ...(cycle.teacher && { person: cycle.teacher._id, personName: fullName(cycle.teacher) }),
    cycle: id,
    cycleName: courseName(cycle),
    text: keep ? `הקורס ${courseName(cycle)} נסגר` : `הקורס ${courseName(cycle)} נמחק`,
    before: [
      `קורס פעיל: ${courseWords(cycle)}`,
      `מ־${dayStr(cycle.startDate)} עד ${dayStr(cycle.endDate)}`,
      sitting.length ? `${sitting.length === 1 ? "בקורס" : `${sitting.length} סטודנטים בקורס`}: ${sitting.map((s) => names.get(String(s.student)) || "?").join(", ")}` : "בלי סטודנטים",
      ...(leaning.length ? [`נשענים עליו: ${leaning.join(", ")}`] : []),
    ],
    after: [
      keep ? `הקורס נסגר: בוטל, והסתיים ב־${dayStr(new Date(startOfToday().getTime() - 24 * 60 * 60 * 1000))}. הדיווחים שלו נשמרו` : "הקורס נמחק",
      ...(sitting.length ? [sitting.length === 1 ? `${names.get(String(sitting[0].student)) || "מי שבקורס"}: לא בקורס הזה עוד` : `${sitting.length} הסטודנטים ירדו מהקורס`] : []),
      ...moves.map((m) => `${m.name}: ${stageHe(m.from) || "בלי שלב"} ← ${stageHe(m.to) || "בלי שלב"}`),
      ...(window ? window.lines : []),
    ],
    raw: { cycle: rawCycle, enrollments: rawSeats, cycleTags: rawTags, leans: { lessons, waits, invoices }, moves, kept: keep },
  });
  return { cycle: id, done: keep ? "closed" : "deleted", moves, ...(window?.windows && { teacher: String(cycle.teacher._id), windows: window.windows }), windowLines: window?.lines || [] };
}

/* ───────────────────────── the journal ───────────────────────── */

/** GET …/log - the super admin's: every change, the newest first (the data kept for putting back stays out of the answer). */
async function journal() {
  const entries = await OrderLog.find().sort({ at: -1 }).limit(2000).select("-raw").lean();
  return { entries };
}

module.exports = { board, mark, link, seatOff, seatOn, windows, courseOff, journal };
