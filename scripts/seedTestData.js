/**
 * @file seedTestData — the TEST world (world:"test") for the matching desk
 * @module scripts/seedTestData
 *
 * A generated, deterministic world whose only purpose is to make the
 * matching desk ("שולחן ההתאמות") comfortable to explore: lots of
 * candidates, teachers with real free windows, cycles with/without
 * seats, contested rooms — all with KNOWN shapes.
 *
 * Ground rules (per Eden, 2026-08-23):
 *   · People are fake (lastName "טסט", world:"test"); the real data is
 *     never touched and shows none of this (the dataset switch narrows
 *     every query by `world` IN THE SERVER now).
 *   · The taxonomy mirrors the REAL subjects — cloned into world:"test"
 *     (subjects are per-world entities since the 2026 remodel).
 *   · Rooms are the real שק"ל rooms, likewise cloned into this world.
 *   · There are NO FRIDAYS: days are Sunday–Thursday (0–4), 08:00–20:00.
 *   · Every student declares availability covering 1/3–2/3 of the week.
 *   · Every teacher declares ~1/3 of the week; inside it sit the cycles
 *     they teach AND free windows.
 *   · Every cycle is classified: capacity + age range + functioning
 *     levels; its required rooms are Room refs.
 *
 * Purge (re-runnable): everything with world:"test" in every collection.
 * The real and pokemon worlds are never read for deletion.
 *
 * Usage:  node scripts/seedTestData.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const { createPersonWithProfile } = require("../services/profileService");
const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const Room = require("../models/Room");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Voucher = require("../models/Voucher");
const Intake = require("../models/Intake");
const Book = require("../models/Book");
const Loan = require("../models/Loan");
const { seedCulture } = require("./lib/cultureSeed");
const { seedLibrary } = require("./lib/librarySeed");
const { importCultureSenzey, formatReport } = require("./lib/senzeyCulture");
const { seedIntakes, purgeUploads } = require("./lib/intakeSeed");

const WORLD = "test";
const DAY = 86400000;
const now = Date.now();

/* ───────────────────── deterministic randomness ───────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260823);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sample = (arr, n) => shuffle(arr).slice(0, n);

/* ───────────────────────── time helpers ───────────────────────── */

const DAY_START = 8 * 60;
const DAY_END = 20 * 60;
const WORK_DAYS = [0, 1, 2, 3, 4]; // א׳–ה׳ — no Fridays, ever
const DAY_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];
const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const overlaps = (list, day, s, e) => list.some((b) => b.day === day && b.s < e && s < b.e);
const hoursOf = (wins) => wins.reduce((n, w) => n + (toMin(w.end) - toMin(w.start)) / 60, 0);
const bd = (age) => new Date(now - Math.round((age * 365.25 + ri(0, 300)) * DAY));

/** Merge touching/overlapping runs of one day list ({day,start,end}). */
function mergeRuns(wins) {
  const byDay = new Map();
  for (const w of wins) {
    if (!byDay.has(w.day)) byDay.set(w.day, []);
    byDay.get(w.day).push([toMin(w.start), toMin(w.end)]);
  }
  const out = [];
  for (const [day, segs] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    segs.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [s, e] of segs) {
      if (!cur || s > cur[1]) {
        if (cur) out.push({ day, start: fmt(cur[0]), end: fmt(cur[1]) });
        cur = [s, e];
      } else cur[1] = Math.max(cur[1], e);
    }
    if (cur) out.push({ day, start: fmt(cur[0]), end: fmt(cur[1]) });
  }
  return out;
}

/* ──────────────────────── the real campus ──────────────────────── */

/** Rooms of the שק"ל centre (from the real course data — no hostels). */
const ROOMS = [
  "מוזיקה",
  "אולפן הקלטות",
  "סטודיו אומנות",
  "סטודיו גרפיקה",
  "חדר מחשבים",
  "חדר שפות",
  "חדר ישיבות",
];

/** Which campus rooms a subject can use (real rooms only).
 *  NOTE the two spellings: the SUBJECT is "מוסיקה" (samekh, as in the real
 *  taxonomy) while the ROOM is "מוזיקה" (zayin). Both are correct. */
const ROOMS_FOR = {
  מוסיקה: ["מוזיקה", "אולפן הקלטות"],
  פסנתר: ["מוזיקה"],
  "פיתוח קול": ["אולפן הקלטות", "מוזיקה"],
  אומנות: ["סטודיו אומנות"],
  ציור: ["סטודיו אומנות"],
  "עיצוב גרפי": ["סטודיו גרפיקה", "חדר מחשבים"],
  "צילום וקולנוע": ["סטודיו גרפיקה", "חדר מחשבים"],
  אנגלית: ["חדר שפות"],
  "כתיבה יוצרת": ["חדר שפות", "חדר ישיבות"],
  "התנהלות כלכלית": ["חדר ישיבות", "חדר מחשבים"],
  זוגיות: ["חדר ישיבות"],
  "אנסמבל מחול": ["חדר ישיבות"],
  יוגה: ["חדר ישיבות"],
  כלבנות: ["חדר ישיבות"],
  נגרות: ["סטודיו אומנות"],
  "בישול ואפייה": ["חדר ישיבות"],
  "אירועים מיוחדים": ["חדר ישיבות"],
};

/* ─────────────────────────── teachers ─────────────────────────── */

/** 15 fake teachers; two subjects (זוגיות, אירועים מיוחדים) have NO
 *  teacher on purpose — they live as domain demand. */
const TEACHERS = [
  { firstName: "נועה", subjects: ["מוסיקה", "פסנתר"] },
  { firstName: "איתי", subjects: ["מוסיקה", "פיתוח קול"] },
  { firstName: "מאיה", subjects: ["פסנתר", "פיתוח קול"] },
  { firstName: "מיכל", subjects: ["אומנות", "ציור"] },
  { firstName: "יונתן", subjects: ["ציור", "עיצוב גרפי"] },
  { firstName: "שירה", subjects: ["עיצוב גרפי", "צילום וקולנוע"] },
  { firstName: "עומר", subjects: ["אנגלית"] },
  { firstName: "הדס", subjects: ["כתיבה יוצרת", "אנגלית"] },
  { firstName: "אלון", subjects: ["התנהלות כלכלית"] },
  { firstName: "רוני", subjects: ["אנסמבל מחול", "יוגה"] },
  { firstName: "תום", subjects: ["יוגה"] },
  { firstName: "ליאור", subjects: ["כלבנות"] },
  { firstName: "גלית", subjects: ["נגרות"] },
  { firstName: "אביב", subjects: ["בישול ואפייה"] },
  // Teaches nothing (yet) — a fully free teacher for the desk.
  { firstName: "דניאל", subjects: ["נגרות", "בישול ואפייה"], free: true },
];

/** ~1/3 of the week (≈20h of 60): 3–4 days, one 4–7h run each. */
function teacherAvailability() {
  let wins;
  do {
    const days = sample(WORK_DAYS, ri(3, 4));
    wins = days.map((day) => {
      const len = ri(4, 7) * 60;
      const start = pick([8 * 60, 9 * 60, 10 * 60, 12 * 60, 13 * 60, 14 * 60]);
      const s = Math.min(start, DAY_END - len);
      return { day, start: fmt(s), end: fmt(s + len) };
    });
  } while (hoursOf(wins) < 17 || hoursOf(wins) > 24);
  return mergeRuns(wins);
}

/* ─────────────────────────── students ─────────────────────────── */

const FIRST_NAMES = [
  "נועם", "שירה", "דוד", "רות", "אהרון", "תמר", "יעקב", "לאה", "אבי", "מיכל",
  "יוסי", "דנה", "עמית", "מאיה", "יואב", "אלה", "אורי", "הילה", "גיל", "נטע",
  "רועי", "ענבר", "אסף", "ליה", "ניר", "טל", "עידו", "שני", "בר", "יובל",
  "איתן", "מור", "זיו", "קרן", "אלעד", "סיון", "נדב", "חן", "עדי", "רון",
  "עומרי", "יעל", "ארז", "גלי", "דור", "ליאת", "אייל", "הדר", "מתן", "רותם",
  "שי", "אביגיל", "יהונתן", "נועה", "בן", "אופיר", "תומר", "מיה", "אוהד", "לירון",
  "רז", "אורית", "דניאל", "אלינור", "עמרי", "ספיר", "איתמר", "יהלי", "שחר", "ענת",
  "גלעד", "עלמה", "ינון", "נעמה", "אביתר", "שקד", "נתנאל", "רוני", "אלון", "הודיה",
  "יונתן", "ליאור", "אריאל", "מירב", "אמיר", "שלומית", "אלכס", "דפנה", "יאיר", "תהילה",
  "משה", "אסתר", "חיים", "רבקה", "שמעון", "שרה", "יצחק", "חנה", "אברהם", "מרים",
];

const LEVELS = ["High", "Medium", "Low"];
const STAGE_PATHS = {
  Interested: ["Interested"],
  Matching: ["Interested", "Matching"],
  Intake: ["Interested", "Matching", "Intake"],
  AwaitingPlacement: ["Interested", "Matching", "Intake", "AwaitingPlacement"],
  Placed: ["Interested", "Matching", "Intake", "AwaitingPlacement", "Placed"],
  NeedsReplacement: ["Placed", "NeedsReplacement"],
};
const MOVED_BY = ["חגי", "נעה", "ייטב"];
const RESIDENCES = ["קהילה", "דיור מוגן", "הוסטל ליבא", "הוסטל עתיד", "משפחה"];

/** 1/3–2/3 of the week (20–40h of 60): 3–5 days, 1–2 runs of 3–8h. */
function studentAvailability(mustInclude = []) {
  let wins;
  do {
    const days = sample(WORK_DAYS, ri(3, 5));
    wins = days.flatMap((day) => {
      const runs = rnd() < 0.3 ? 2 : 1;
      const out = [];
      let cursor = pick([8 * 60, 8 * 60, 9 * 60, 10 * 60, 12 * 60, 14 * 60]);
      for (let r = 0; r < runs; r++) {
        const len = ri(3, runs === 2 ? 5 : 8) * 60;
        const s = Math.min(cursor, DAY_END - len);
        out.push({ day, start: fmt(s), end: fmt(s + len) });
        cursor = s + len + 60;
        if (cursor >= DAY_END - 120) break;
      }
      return out;
    });
    wins = mergeRuns([...wins, ...mustInclude]);
  } while (hoursOf(wins) < 20 || hoursOf(wins) > 40);
  return wins;
}

/* ───────────────────────── cycle shapes ───────────────────────── */

/** kind → minutes, capacity range, format */
const KINDS = {
  private: { minutes: 45, cap: [1, 1], format: "Private", label: "שיעור פרטני" },
  pair: { minutes: 60, cap: [2, 2], format: "Group", label: "זוג" },
  small: { minutes: 90, cap: [4, 6], format: "Group", label: "קבוצה קטנה" },
  full: { minutes: 90, cap: [6, 8], format: "Group", label: "קבוצה" },
  open: { minutes: 120, cap: [8, 10], format: "Group", label: "קבוצה פתוחה" },
};
const AGE_BANDS = [[18, 30], [18, 45], [21, 40], [25, 60], [18, 65], [30, 65], [40, 65]];
const LEVEL_SETS = [
  ["High"],
  ["High", "Medium"],
  ["Medium"],
  ["Medium", "Low"],
  ["High", "Medium", "Low"],
  ["Low"],
];
/** How full a cycle is: full / last seat / half / fresh. */
const FILLS = ["full", "last", "half", "half", "fresh"];
const dayPart = (s) => (s < 12 * 60 ? "בוקר" : s < 16 * 60 ? "צהריים" : "ערב");

/* ─────────────────────────────── run ─────────────────────────────── */

(async () => {
  await connectDB();

  /* 1 ── purge the whole test world (by `world` tag only) */
  const purged = {};
  for (const [name, Model] of Object.entries({
    lessons: Lesson,
    enrollments: Enrollment,
    cycles: Cycle,
    eventRegistrations: EventRegistration,
    events: Event,
    vouchers: Voucher,
    intakes: Intake,
    loans: Loan,
    books: Book,
    profiles: Profile,
    people: Person,
    subjects: Subject,
    rooms: Room,
  })) {
    purged[name] = (await Model.deleteMany({ world: WORLD })).deletedCount;
  }
  purgeUploads(WORLD);
  console.log(
    "Purged world:test — " +
      Object.entries(purged).map(([k, v]) => `${k} ${v}`).join(" · ")
  );

  /* 2 ── taxonomy + rooms: clones of the real ones into this world */
  const realSubjects = await Subject.find({ world: "real" }).lean();
  if (!realSubjects.length) {
    console.error('⛔ No real subjects found — seed the real world first.');
    process.exit(1);
  }
  const subjectDocs = await Subject.insertMany(
    realSubjects.map((s) => ({
      world: WORLD,
      name: s.name,
      category: s.category,
      active: true,
    }))
  );
  const subjectByName = Object.fromEntries(subjectDocs.map((s) => [s.name, s]));
  for (const name of Object.keys(ROOMS_FOR)) {
    if (!subjectByName[name]) console.warn(`⚠ subject "${name}" is not in the real taxonomy`);
  }
  const roomDocs = await Room.insertMany(
    ROOMS.map((name) => ({ world: WORLD, name, active: true }))
  );
  const roomByName = Object.fromEntries(roomDocs.map((r) => [r.name, r]));
  console.log(
    `Subjects: ${subjectDocs.length} (clones of the real taxonomy) · rooms: ${ROOMS.join(", ")}`
  );

  /** Subject ids of a name list (skips names missing from the taxonomy). */
  const subjIds = (names) => names.map((n) => subjectByName[n]?._id).filter(Boolean);

  /* 3 ── teachers (availability ≈ 1/3 week, subjects = Subject refs) */
  const teachers = [];
  let tn = 0;
  for (const t of TEACHERS) {
    const availability = teacherAvailability();
    const { person } = await createPersonWithProfile("Teacher", {
      world: WORLD,
      firstName: t.firstName,
      lastName: "טסט",
      email: `test_teacher_${tn}@test.local`,
      phone: `052-7${String(100000 + tn * 731).slice(0, 6)}`,
      availability,
      subjects: subjIds(t.subjects),
    });
    teachers.push({ ...t, person, availability, busy: [] });
    tn++;
  }
  const teachersOf = (name) => teachers.filter((t) => !t.free && t.subjects.includes(name));
  console.log(`Teachers: ${teachers.length} (כולם "טסט", ≈1/3 שבוע זמינות)`);

  /* 4 ── cycles: scheduled inside the teacher's availability, in real
   *      rooms, no teacher/room clash, 15-min buffers */
  const roomBusy = Object.fromEntries(ROOMS.map((r) => [r, []]));
  const schedule = (t, rooms, minutes) => {
    const wins = shuffle(t.availability);
    for (const w of wins) {
      const ws = toMin(w.start);
      const we = toMin(w.end);
      for (const room of shuffle(rooms)) {
        for (let s = ws; s + minutes <= we; s += 15) {
          const e = s + minutes;
          if (overlaps(t.busy, w.day, s, e)) continue;
          if (overlaps(roomBusy[room], w.day, s, e)) continue;
          t.busy.push({ day: w.day, s, e: e + 15 });
          roomBusy[room].push({ day: w.day, s, e: e + 15 });
          return { day: w.day, s, e, room };
        }
      }
    }
    return null;
  };

  const cycles = []; // {base, kind, teacher, slot, cap, fill, matching, doc?}
  const plannedBases = ["זוגיות", "אירועים מיוחדים", "כלבנות"];
  const subjectNames = realSubjects.map((s) => s.name);
  for (const base of subjectNames) {
    if (!ROOMS_FOR[base]) continue;
    const tchs = teachersOf(base);
    if (!tchs.length) continue;
    const nCycles = pick([2, 2, 3, 3, 4, 4]);
    const kinds = shuffle(["full", "private", "small", "open", "pair", "small", "full"]).slice(0, nCycles);
    for (const kind of kinds) {
      // Least-loaded teacher of the subject first — every teaching teacher
      // ends up with cycles inside their availability (דניאל stays free).
      const load = (x) => cycles.filter((c) => c.teacher === x).length;
      const t = shuffle(tchs).sort((a, b) => load(a) - load(b))[0];
      const K = KINDS[kind];
      const slot = schedule(t, ROOMS_FOR[base], K.minutes);
      if (!slot) continue; // teacher's week is full — skip this shape
      const cap = ri(K.cap[0], K.cap[1]);
      const fill = kind === "private" ? pick(["full", "fresh"]) : pick(FILLS);
      const [ageMin, ageMax] = pick(AGE_BANDS);
      cycles.push({
        base,
        kind,
        teacher: t,
        slot,
        cap,
        fill,
        matching: {
          capacity: cap,
          ageMin,
          ageMax,
          functioningLevels: kind === "private" ? pick([["Low"], ["Medium", "Low"], ["High"]]) : pick(LEVEL_SETS),
          format: K.format,
          enrollmentOpen: true,
          requiredRooms: [roomByName[slot.room]._id],
          requirements: kind === "open" ? "פתוח לכולם" : undefined,
        },
      });
    }
  }
  // A few PLANNED cycles (no teacher, no schedule) — demand placeholders.
  for (const base of plannedBases) {
    if (!subjectByName[base]) continue;
    const roomName = ROOMS_FOR[base]?.[0];
    cycles.push({
      base,
      kind: "planned",
      teacher: null,
      slot: null,
      cap: 8,
      fill: "fresh",
      matching: {
        capacity: 8,
        ageMin: 18,
        ageMax: 65,
        functioningLevels: ["High", "Medium", "Low"],
        format: "Group",
        enrollmentOpen: true,
        requiredRooms: roomName && roomByName[roomName] ? [roomByName[roomName]._id] : [],
      },
    });
  }
  // Two cycles closed for enrollment (seat exists but the door is shut).
  for (const c of sample(cycles.filter((c) => c.slot && c.fill !== "full"), 2)) {
    c.matching.enrollmentOpen = false;
  }

  /* 5 ── students */
  const wanted = (c) =>
    c.fill === "full" ? c.cap : c.fill === "last" ? c.cap - 1 : c.fill === "half" ? Math.max(1, Math.floor(c.cap / 2)) : 0;
  const seatsToFill = cycles.reduce((n, c) => n + wanted(c), 0);

  const STAGE_COUNTS = {
    Placed: 0, // derived from the seats below
    Matching: 24,
    NeedsReplacement: 7,
    AwaitingPlacement: 5,
    Intake: 4,
    Interested: 7,
  };
  const placedCount = Math.ceil(seatsToFill / 2.2); // ~2 cycles per placed student
  STAGE_COUNTS.Placed = placedCount;
  const names = shuffle(FIRST_NAMES);
  const withTeachers = subjectNames.filter((b) => teachersOf(b).length);
  const basesWithSeats = [...new Set(cycles.filter((c) => c.slot && wanted(c) < c.cap && c.matching.enrollmentOpen).map((c) => c.base))];
  const basesFull = [...new Set(cycles.filter((c) => c.slot && wanted(c) >= c.cap).map((c) => c.base))];
  const noTeacherBases = subjectNames.filter((b) => ROOMS_FOR[b] && !teachersOf(b).length);

  const students = []; // {person, stage, interests, availability, level, age, enrolled: [cycle]}
  let sn = 0;
  const mkStudent = async (stage, interests, availability, extra = {}) => {
    const age = extra.age ?? ri(18, 62);
    const first = names[sn % names.length];
    const path = STAGE_PATHS[stage];
    const firstMoveAgo = ri(10, 70);
    const stepDays = Math.max(2, Math.floor(firstMoveAgo / path.length));
    const stageHistory = path.map((st, idx) => ({
      stage: st,
      movedBy: MOVED_BY[(sn + idx) % MOVED_BY.length],
      movedAt: new Date(now - (firstMoveAgo - idx * stepDays) * DAY),
      note: "",
    }));
    const level = extra.level || pick(LEVELS);
    const groupPreference = extra.groupPreference || pick(["Group", "Group", "Group", "Flexible", "Private"]);
    // pipeline.{stage,since} must agree with the history tail — the model's
    // sync hook asserts exactly that on every save.
    const tail = stageHistory[stageHistory.length - 1];
    const { person } = await createPersonWithProfile("StudentCollege", {
      world: WORLD,
      firstName: first,
      lastName: "טסט",
      email: `test_student_${sn}@test.local`,
      phone: `053-${String(6000000 + sn * 917).slice(0, 7)}`,
      birthDate: bd(age),
      gender: sn % 2 ? "female" : "male",
      availability,
      pipeline: { stage: tail.stage, since: tail.movedAt },
      stageHistory,
      matching: { functioningLevel: level, groupPreference, interests: subjIds(interests) },
      residence: { label: pick(RESIDENCES) },
      notes: "סטודנט בדיקה — לא אמיתי",
      import: { registrationSource: "נתוני טסט" },
    }, { trusted: true });
    const s = { person, stage, interests, availability, level, age, groupPreference, enrolled: [] };
    students.push(s);
    sn++;
    return s;
  };

  // 5a — Placed students fill the cycles' seats (no time clashes).
  const openSeats = cycles.filter((c) => c.slot).map((c) => ({ c, left: wanted(c) }));
  for (let i = 0; i < placedCount; i++) {
    const mine = [];
    const per = pick([1, 2, 2, 3]);
    for (const o of shuffle(openSeats)) {
      if (mine.length >= per) break;
      if (o.left <= 0) continue;
      const { day, s, e } = o.c.slot;
      if (mine.some((m) => m.slot.day === day && m.slot.s < e && s < m.slot.e)) continue;
      o.left--;
      mine.push(o.c);
    }
    const lessonWins = mine.map((c) => ({ day: c.slot.day, start: fmt(c.slot.s), end: fmt(c.slot.e) }));
    const interests = [...new Set([...mine.map((c) => c.base), ...(rnd() < 0.4 ? [pick(withTeachers)] : [])])];
    const c0 = mine[0];
    const st = await mkStudent("Placed", interests, studentAvailability(lessonWins), {
      age: c0 ? ri(c0.matching.ageMin, c0.matching.ageMax) : undefined,
      level: c0 ? pick(c0.matching.functioningLevels) : undefined,
      groupPreference: c0?.kind === "private" ? "Private" : undefined,
    });
    st.enrolled = mine;
  }
  // Any seats still unfilled → top up with extra placed students.
  while (openSeats.some((o) => o.left > 0)) {
    const o = openSeats.find((x) => x.left > 0);
    o.left--;
    const win = [{ day: o.c.slot.day, start: fmt(o.c.slot.s), end: fmt(o.c.slot.e) }];
    const st = await mkStudent("Placed", [o.c.base], studentAvailability(win), {
      age: ri(o.c.matching.ageMin, o.c.matching.ageMax),
      level: pick(o.c.matching.functioningLevels),
    });
    st.enrolled = [o.c];
  }

  // 5b — the desk candidates: designed interest mixes.
  const candidateInterests = () => {
    const r = rnd();
    if (r < 0.45) return sample(basesWithSeats, ri(1, 2)); // clean fits
    if (r < 0.65) return [pick(basesFull), ...sample(basesWithSeats, 1)]; // waits + fit
    if (r < 0.8) return sample(basesFull, 1); // only full cycles → waiting
    if (r < 0.92) return [pick(noTeacherBases), ...sample(basesWithSeats, ri(0, 1))]; // no teacher
    return sample(withTeachers, 3); // broad
  };
  for (const [stage, n] of Object.entries(STAGE_COUNTS)) {
    if (stage === "Placed") continue;
    for (let i = 0; i < n; i++) {
      const interests =
        stage === "Interested" && rnd() < 0.4 ? [] : [...new Set(candidateInterests().filter(Boolean))];
      const availability = studentAvailability(); // every student: 1/3–2/3
      await mkStudent(stage, interests, availability);
    }
  }
  console.log(
    `Students: ${students.length} — ` +
      Object.entries(
        students.reduce((m, s) => ((m[s.stage] = (m[s.stage] || 0) + 1), m), {})
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ")
  );

  /* 6 ── write the cycles (schedule slots carry the room ref) */
  const startDate = new Date(now - 60 * DAY);
  const endDate = new Date(now + 300 * DAY);
  const plannedStart = new Date(now + 45 * DAY);
  for (const c of cycles) {
    c.doc = await Cycle.create({
      world: WORLD,
      subject: subjectByName[c.base]._id,
      teacher: c.teacher ? c.teacher.person._id : null,
      status: c.kind === "planned" ? "Planned" : "Active",
      startDate: c.kind === "planned" ? plannedStart : startDate,
      endDate,
      schedule: c.slot
        ? [
            {
              day: c.slot.day,
              start: fmt(c.slot.s),
              end: fmt(c.slot.e),
              room: roomByName[c.slot.room]._id,
            },
          ]
        : [],
      matching: c.matching,
    });
  }

  /* 7 ── enrollments: the placed students take their seats */
  let enrolled = 0;
  for (const c of cycles) {
    const cohort = students.filter((s) => s.enrolled.includes(c));
    for (const [i, s] of cohort.entries()) {
      await Enrollment.create({
        world: WORLD,
        cycle: c.doc._id,
        student: s.person._id,
        status: "active",
        slotId: c.doc.schedule[0]?._id || null,
        joinedAt: new Date(now - (55 - i * 3) * DAY),
        registeredAt: new Date(now - (58 - i * 3) * DAY),
      });
      enrolled++;
    }
    c.enrolledCount = cohort.length;
  }
  console.log(
    `Cycles: ${cycles.length} (${cycles.filter((c) => c.slot).length} active, ` +
      `${cycles.filter((c) => !c.slot).length} planned) — כולם מסווגים · ${enrolled} שיבוצים`
  );

  /* 8 ── seat holds: Intake / AwaitingPlacement students reserve a seat
   *      (an enrollment with status "reserved" — it counts against
   *      capacity from every view) */
  const holders = students.filter((s) => s.stage === "Intake" || s.stage === "AwaitingPlacement").slice(0, 3);
  let held = 0;
  for (const s of holders) {
    const target =
      cycles.find((c) => c.slot && c.enrolledCount < c.cap && s.interests.includes(c.base)) ||
      cycles.find((c) => c.slot && c.enrolledCount < c.cap);
    if (!target) break;
    await Enrollment.create({
      world: WORLD,
      cycle: target.doc._id,
      student: s.person._id,
      status: "reserved",
      reservedAt: new Date(now - ri(1, 9) * DAY),
      note: "מקום שמור עד סיום קליטה",
      createdBy: "נעה",
    });
    target.enrolledCount++;
    held++;
  }

  /* 9 ── a few weeks of reported attendance on the running cycles */
  const STATUSES = ["Present", "Present", "Present", "AnnouncedAbsence", "Missing"];
  let lessonCount = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const c of cycles) {
    if (!c.slot) continue;
    const cohort = students.filter((s) => s.enrolled.includes(c));
    if (!cohort.length) continue;
    // The last 4 occurrences of this cycle's weekday.
    for (let back = 1; back <= 28; back++) {
      const d = new Date(today.getTime() - back * DAY);
      if (d.getUTCDay() !== c.slot.day) continue;
      if (lessonCount > 400) break;
      await Lesson.create({
        world: WORLD,
        cycle: c.doc._id,
        date: d,
        source: "live",
        attendance: cohort.map((s) => ({
          student: s.person._id,
          status: pick(STATUSES),
        })),
      });
      lessonCount++;
    }
  }

  /* 10 ── summary per subject */
  console.log("\nמקצוע · מחזורים [יום התחלה–סיום @חדר קיבולת/מלאים]:");
  for (const base of subjectNames) {
    const mine = cycles.filter((c) => c.base === base);
    if (!mine.length) {
      if (ROOMS_FOR[base]) console.log(`  ${base}: — (אין מורה → ביקוש כתחום)`);
      continue;
    }
    const tchs = teachersOf(base).map((t) => t.firstName).join("/") || "אין מורה";
    console.log(
      `  ${base} (${tchs}): ` +
        mine
          .map((c) =>
            c.slot
              ? `[${DAY_HE[c.slot.day]} ${fmt(c.slot.s)}–${fmt(c.slot.e)} @${c.slot.room} ${c.enrolledCount}/${c.cap}${c.matching.enrollmentOpen ? "" : " סגור"}]`
              : `[מתוכנן 0/${c.cap}]`
          )
          .join(" ")
    );
  }
  const avgStudentHours = (students.reduce((n, s) => n + hoursOf(s.availability), 0) / students.length).toFixed(1);
  const avgTeacherHours = (teachers.reduce((n, t) => n + hoursOf(t.availability), 0) / teachers.length).toFixed(1);
  console.log(
    `\n✅ Done — עולם טסט (world:"test"): ${teachers.length} מורים (ממוצע ${avgTeacherHours} ש׳ זמינות), ` +
      `${students.length} סטודנטים (ממוצע ${avgStudentHours} ש׳ זמינות), ${cycles.length} מחזורים, ` +
      `${enrolled} שיבוצים, ${held} מקומות שמורים, ${lessonCount} שיעורים מדווחים. אין ימי שישי.`
  );

  /* 11 ── תרבות לכל: staff, culture-only students, both-programs students,
   *       transfers (dated, with the seats given back), events + vouchers */
  // Guests = college students who are NOT in culture (family/friends in real
  // life; here the nearest fake stand-in). Excludes the ones seedCulture
  // will move/join — it picks Placed students, so offer the others.
  const guestPool = students.filter((s) => s.stage !== "Placed").map((s) => s.person);
  await seedCulture({
    world: WORLD,
    rnd,
    collegeStudents: students,
    availabilityFn: () => studentAvailability(),
    guestPool,
    flavour: {
      lastName: "טסט",
      emailPrefix: "test",
      emailDomain: "test.local",
      systemActor: "מערכת",
      studentNote: "סטודנט/ית תרבות לכל — נתוני טסט",
      // The real program is run by one coordinator (99% of the senzey rows)
      // with an occasional second hand — same shape here, fake surnames.
      staff: [
        { firstName: "שירן", title: "רכזת תרבות לכל" },
        { firstName: "גפן", title: "עובד/ת תרבות ופנאי" },
      ],
      guestReasons: ["אמא של המשתתפ/ת", "אח/ות", "חבר/ה מהדיור", "מדריך/ה מלווה"],
      studentFirstNames: [
        "אביה", "יובל", "שירה", "נהוראי", "תמר", "אלמוג", "ליאן", "עמית", "דניאלה", "רועי",
        "נועה", "יהונתן", "מעיין", "אורי", "הילה", "איתי", "טליה", "עומר", "שני", "אלון",
        "ניצן", "רון", "גפן", "יואב", "אגם", "בר",
      ],
      transferNotes: {
        toCulture: ["העדיף/ה את הטיולים והמופעים על פני קורס שבועי", "הפסיק/ה ללמוד — ממשיך/ה רק באירועי תרבות", "לבקשת המשפחה — פחות מחויבות שבועית"],
        toCollege: ["ביקש/ה ללמוד קורס קבוע אחרי שנה של אירועים", "עבר/ה למסלול המכללה בעקבות שיחת קליטה"],
      },
      cancelReasons: ["חולה", "עבודה באותו ערב", "לא מצא/ה הסעה", "שינוי תוכניות משפחתי"],
      eventCancelReasons: ["המופע בוטל ע\"י התיאטרון", "מזג אוויר סוער — הטיול נדחה"],
      attendanceNotes: {
        present: ["הגיע/ה עם מלווה", "נהנה/תה מאוד", "הצטרף/ה באיחור קל"],
        absent: ["הודיע/ה מראש", "לא הגיע/ה ולא הודיע/ה", "חולה"],
      },
      voucherNotes: ["יום הולדת", "השתתפות פעילה", "מתנת סוף שנה", "עידוד"],
      voucherPlaces: [
        { name: "סינמה סיטי", prefix: "CIN", note: "תקף בכל הסניפים" },
        { name: "קפה גרג", prefix: "GRG" },
        { name: "סטימצקי", prefix: "STM" },
        { name: "ארומה", prefix: "ARM" },
        { name: "יס פלנט", prefix: "YES" },
        { name: "המשביר לצרכן", prefix: "MSB" },
      ],
      // The real "יציאות בקהילה" vocabulary (senzey, תשפ"ו): workshops and
      // social evenings at the department's own hall (פנאי · יד חרוצים 9),
      // cinema, Jerusalem Theatre, bowling, restaurant/café outings split
      // צעירים/מבוגרים, women-only mornings, tours, nature, holiday parties —
      // plus one template per finer performance kind (musical, dance,
      // stand-up, concert) and the new outing kinds (festival, a game, a
      // museum) so the calendar demo shows the whole vocabulary.
      events: [
        { name: "סדנת אפיה", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 20, hour: 17, endTime: "19:00", description: "סדנת אפיה שבועית עם שרה" },
        { name: "סדנת בישול", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 18, hour: 17, endTime: "19:00" },
        { name: "בוקר נשים", category: "community", location: "מרכז פנאי · יד חרוצים 9", capacity: 15, gender: "women", hour: 11, endTime: "13:00", description: "מפגש נשים שבועי — קפה, שיחה ופעילות" },
        { name: "ערב הורים וילדים", category: "community", location: "מרכז פנאי · יד חרוצים 9", capacity: 16, hour: 17, endTime: "19:00", guests: true, description: "ערב משותף למשתתפים ולבני משפחה" },
        { name: "סרט בבוקר", category: "movie", location: "סינמה סיטי ירושלים · דרך רבין 10", capacity: 22, hour: 11, endTime: "13:00" },
        { name: "סרט בערב", category: "movie", location: "סינמה סיטי ירושלים · דרך רבין 10", capacity: 22, hour: 18, endTime: "20:30" },
        { name: "הצגה — \"הזוג המוזר\"", category: "theatre", location: "תיאטרון ירושלים", capacity: 10, hour: 20, endTime: "22:15", price: 40 },
        { name: "הצגה — \"משכנתא\"", category: "theatre", location: "תיאטרון ירושלים", capacity: 8, hour: 20, endTime: "22:15", price: 40 },
        { name: "מחזמר — \"שלמה המלך ושלמי הסנדלר\"", category: "musical", location: "תיאטרון ירושלים", capacity: 12, hour: 20, endTime: "22:30", price: 60 },
        { name: "מופע מחול — להקת בת-שבע", category: "dance", location: "תיאטרון ירושלים", capacity: 10, hour: 20, endTime: "21:30", price: 50 },
        { name: "באולינג", category: "outing", location: "קניון לב תלפיות · האומן 17", capacity: 16, hour: 12, endTime: "14:00" },
        { name: "מוסא צעירים", category: "restaurant", location: "מסעדת מוסא · קניון מלחה", capacity: 14, hour: 18, endTime: "20:00", ageMin: 18, ageMax: 32, description: "ארוחת ערב לצעירים" },
        { name: "מוסא מבוגרים", category: "restaurant", location: "מסעדת מוסא · קניון מלחה", capacity: 12, hour: 12, endTime: "14:00", ageMin: 33 },
        { name: "ארומה מבוגרים", category: "restaurant", location: "ארומה · עמק רפאים 43", capacity: 12, hour: 11, endTime: "13:00", ageMin: 33 },
        { name: "נוקטורנו — מופע מוזיקלי", category: "concert", location: "נוקטורנו · בצלאל 7", capacity: 17, hour: 19, endTime: "21:30" },
        { name: "פסטיבל האור בעיר העתיקה", category: "festival", location: "העיר העתיקה", capacity: 25, hour: 19, endTime: "22:00" },
        { name: "משחק כדורסל — הפועל ירושלים", category: "sportEvent", location: "היכל הפיס ארנה · מלחה", capacity: 15, hour: 19, endTime: "21:30", price: 30 },
        { name: "ביקור במוזיאון ישראל", category: "museum", location: "מוזיאון ישראל · רופין 11", capacity: 16, hour: 10, endTime: "13:00" },
        { name: "סטודיו מדרחוב", category: "workshop", location: "סטודיו מדרחוב · הלני המלכה 3", capacity: 12, hour: 18, endTime: "19:45" },
        { name: "סיור יום ירושלים — הרובע היהודי", category: "trip", location: "העיר העתיקה", capacity: 18, hour: 11, endTime: "15:00", ageMax: 60 },
        { name: "סיור במוזיאון הכנסת", category: "museum", location: "רחוב המלך ג'ורג' 24", capacity: 14, hour: 13, endTime: "15:00" },
        { name: "פיקניק בטבע וארוחת בוקר", category: "trip", location: "יער ירושלים", capacity: 21, hour: 11, endTime: "14:30" },
        { name: "ערב על האש", category: "community", location: "גן הפעמון", capacity: 32, hour: 18, endTime: "21:00", guests: true },
        { name: "כלבנות טיפולית", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 15, hour: 16, endTime: "17:30" },
        { name: "פייטנות", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 6, hour: 19, endTime: "19:45", description: "קבוצה קטנה — שירה ופיוט" },
        { name: "סדנת כלים להתמודדות — \"מחשבות מגבילות\"", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 14, hour: 12, endTime: "13:30" },
        { name: "סדנת סטיילינג עם אפרת", category: "workshop", location: "מרכז פנאי · יד חרוצים 9", capacity: 13, hour: 17, endTime: "18:30" },
        { name: "מסיבת חג", category: "party", location: "מרכז פנאי · יד חרוצים 9", capacity: 55, hour: 17, endTime: "20:00", guests: true },
        { name: "התנדבות — אריזות לחיילים", category: "volunteering", location: "מרכז פנאי · יד חרוצים 9", capacity: 17, hour: 17, endTime: "19:00" },
        { name: "אימון טניס חוויתי", category: "sport", location: "מרכז הטניס במלחה", capacity: 8, hour: 11, endTime: "12:30", ageMax: 50 },
        { name: "קונצרט סוף שנה", category: "concert", location: "תיאטרון ירושלים", capacity: 14, hour: 19, endTime: "21:00" },
        { name: "סטנדאפ — \"שלומי קוריאט\"", category: "standup", location: "זאפה ירושלים", capacity: 8, hour: 20, endTime: "22:00", price: 240, ageMin: 21 },
      ],
    },
  });

  /* 12 ── the REAL תרבות לכל history (senzey תשפ"ו) with fake stand-ins:
   *       the 93 actual outings, their registrations and members, so the
   *       calendar of last year is the real one here too (Eden, 2026-09-07). */
  const senzey = await importCultureSenzey({ world: WORLD, people: "fake", log: console.log });
  console.log(formatReport(senzey));

  /* 13 ── קליטה: the social worker's board in every state of Eden's diagram
   *       (landing-page leads, held seats, scheduled/overdue meetings,
   *       missing documents, completed intakes) — through the real services. */
  const seatable = cycles.filter((c) => c.slot && c.matching.enrollmentOpen && c.enrolledCount < c.cap);
  let seatIdx = 0;
  const findSeat = () => {
    while (seatIdx < seatable.length && seatable[seatIdx].enrolledCount >= seatable[seatIdx].cap) seatIdx++;
    const c = seatable[seatIdx];
    if (!c) return null;
    c.enrolledCount++;
    return c.doc._id;
  };
  await seedIntakes({
    world: WORLD,
    lastName: "טסט",
    findSeat,
    subjectIds: ["ציור", "מוסיקה", "בישול ואפייה", "אנגלית", "יוגה"].map((n) => subjectByName[n]?._id).filter(Boolean).map(String),
    log: console.log,
  });

  /* 14 ── הספרייה: a dozen books, a few with students (one overdue, one
   *       extended), some returned history — through libraryService. */
  await seedLibrary({
    world: WORLD,
    students: students.filter((s) => s.stage === "Placed").slice(0, 8).map((s) => s.person),
    by: "נעה",
    log: console.log,
  });

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
