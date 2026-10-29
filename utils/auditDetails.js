/**
 * @file auditDetails - a write in full words
 * @module utils/auditDetails
 *
 * Eden (2026-10-29, on the first activity rows: "אשמח שהדברים יהיו יותר
 * מפורטים"). utils/auditDescribe says WHAT a write was; this says what it
 * was ABOUT, in words a person reads: ids become names (a course by its
 * subject and house, a student by name, an event, a voucher…), keys become
 * Hebrew labels, enum values their labels, dates "29.10.26"; an edit says
 * what changed, from what to what (the row as it was before the handler
 * ran is handed in by utils/audit); the routes that deserve a sentence of
 * their own get one (attendance by name and status, a seat, a stage, a
 * transfer, a loan…).
 *
 *   details({ method, path, route, body, answer, before, kind })
 *     → { summary, facts: [{label, value}], changes: [{field, label, from, to}], label }
 *
 * Everything here is best effort and never throws at the caller.
 */

const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const { Profile } = require("../models/Profile");
const Cycle = require("../models/Cycle");
const Hostel = require("../models/Hostel");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Voucher = require("../models/Voucher");
const Book = require("../models/Book");
const Loan = require("../models/Loan");
const Room = require("../models/Room");
const Subject = require("../models/Subject");
const SubjectCategory = require("../models/SubjectCategory");
const StaffAccount = require("../models/StaffAccount");
const Supplier = require("../models/Supplier");
const Enrollment = require("../models/Enrollment");
const Intake = require("../models/Intake");
const Activity = require("../models/Activity");
const Incident = require("../models/Incident");
const Invoice = require("../models/Invoice");
const InvoiceRound = require("../models/InvoiceRound");
const HostelReport = require("../models/HostelReport");
const DiaryEntry = require("../models/DiaryEntry");
const Lesson = require("../models/Lesson");
const StoredFile = require("../models/StoredFile");
const { Tag } = require("../models/Tag");
const GymMembership = require("../models/GymMembership");
const D = require("./domain");

const ID_RE = /^[0-9a-f]{24}$/i;
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const asId = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v != null ? String(v) : "");

/* ───────── names for ids ───────── */

const personName = (p) => (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "");
const cycleName = (c) => {
  if (!c) return "";
  const subject = c.subject && typeof c.subject === "object" ? c.subject.name : "";
  const hostel = c.hostel && typeof c.hostel === "object" ? c.hostel.name : "";
  return [subject || "קורס", hostel].filter(Boolean).join(" · ");
};
const monthHe = (m) => {
  if (!/^\d{4}-\d{2}$/.test(String(m || ""))) return String(m || "");
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1]} ${y}`;
};
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const labelIn = (list, key) => (list || []).find((x) => x.key === key)?.label || "";

/**
 * Every model a write may touch: how to load one row for a name (and, for
 * the target, for the "before" picture) and how to name it.
 */
const KINDS = {
  Person: { model: Person, select: "firstName lastName", name: personName },
  Profile: { model: Profile, select: "person kind pipeline", populate: [["person", "firstName lastName"]], name: (p) => [personName(p.person), labelIn(D.PROFILE_KINDS, p.kind)].filter(Boolean).join(" · ") },
  Cycle: { model: Cycle, select: "subject hostel teacher status startDate endDate schedule matching venue", populate: [["subject", "name"], ["hostel", "name"], ["teacher", "firstName lastName"]], name: cycleName },
  Hostel: { model: Hostel, select: "name kind", name: (h) => h.name },
  Event: { model: Event, select: "name date status", name: (e) => e.name },
  EventRegistration: { model: EventRegistration, select: "event student status", populate: [["event", "name"], ["student", "firstName lastName"]], name: (r) => [personName(r.student), r.event?.name].filter(Boolean).join(" · ") },
  Voucher: { model: Voucher, select: "name number balance", name: (v) => `${v.name || "שובר"}${v.number ? ` #${v.number}` : ""}` },
  Book: { model: Book, select: "title author", name: (b) => b.title },
  Loan: { model: Loan, select: "book student dueAt", populate: [["book", "title"], ["student", "firstName lastName"]], name: (l) => [l.book?.title, personName(l.student)].filter(Boolean).join(" · ") },
  Room: { model: Room, select: "name capacity", name: (r) => r.name },
  Subject: { model: Subject, select: "name category", name: (s) => s.name },
  SubjectCategory: { model: SubjectCategory, select: "label active", name: (c) => c.label },
  StaffAccount: { model: StaffAccount, select: "name username kind title", name: (a) => a.name },
  Supplier: { model: Supplier, select: "firstName lastName status", name: personName },
  Enrollment: { model: Enrollment, select: "cycle student status joinedAt leftAt note", populate: [["student", "firstName lastName"], ["cycle", "subject hostel"]], name: (e) => personName(e.student) },
  Intake: { model: Intake, select: "person status", populate: [["person", "firstName lastName"]], name: (i) => personName(i.person) },
  Activity: { model: Activity, select: "person kind title", populate: [["person", "firstName lastName"]], name: (a) => [personName(a.person), labelIn(D.ACTIVITY_KINDS, a.kind) || a.title].filter(Boolean).join(" · ") },
  Incident: { model: Incident, select: "person primary", populate: [["person", "firstName lastName"]], name: (i) => personName(i.person) },
  Invoice: { model: Invoice, select: "teacher", populate: [["teacher", "firstName lastName"]], name: (i) => personName(i.teacher) },
  InvoiceRound: { model: InvoiceRound, select: "month program", name: (r) => `${monthHe(r.month)} · ${D.INVOICE_ROUND_PROGRAM_LABELS[r.program] || r.program}` },
  HostelReport: { model: HostelReport, select: "hostel month", populate: [["hostel", "name"]], name: (r) => `${r.hostel?.name || "בית"} · ${monthHe(r.month)}` },
  DiaryEntry: { model: DiaryEntry, select: "title kind date", name: (d) => d.title },
  Lesson: { model: Lesson, select: "cycle date", populate: [["cycle", "subject hostel"]], name: (l) => fmtDate(l.date) },
  StoredFile: { model: StoredFile, select: "name family", name: (f) => f.name },
  GymMembership: { model: GymMembership, select: "person membership contract.signedAt", populate: [["person", "firstName lastName"]], name: (m) => personName(m.person) },
};

/** The model behind a route's first segments, for the target. */
const TARGET_BY_ROUTE = [
  [/^\/people\/:id/, "Person"],
  [/^\/profiles\/:id/, "Profile"],
  [/^\/cycles\/:id/, "Cycle"],
  [/^\/enrollments\/:id/, "Enrollment"],
  [/^\/lessons\/:id/, "Lesson"],
  [/^\/rooms\/:id/, "Room"],
  [/^\/hostels\/:id/, "Hostel"],
  [/^\/hostel-reports\/:id/, "HostelReport"],
  [/^\/events\/:id/, "Event"],
  [/^\/event-registrations\/:id/, "EventRegistration"],
  [/^\/vouchers\/:id/, "Voucher"],
  [/^\/intakes\/:id/, "Intake"],
  [/^\/suppliers\/:id/, "Supplier"],
  [/^\/activities\/:id/, "Activity"],
  [/^\/incidents\/:id/, "Incident"],
  [/^\/library\/books\/:id/, "Book"],
  [/^\/library\/loans\/:id/, "Loan"],
  [/^\/invoices\/:id/, "Invoice"],
  [/^\/invoice-rounds\/:id/, "InvoiceRound"],
  [/^\/diary\/:id/, "DiaryEntry"],
  [/^\/tags\/people\/:id/, "Person"],
  [/^\/accounts\/:id/, "StaffAccount"],
  [/^\/files\/:id/, "StoredFile"],
  [/^\/subjects\/:id/, "Subject"],
  [/^\/subject-categories\/:id/, "SubjectCategory"],
  [/^\/gym\/:id/, "GymMembership"],
];

const targetKindOf = (route) => (TARGET_BY_ROUTE.find(([re]) => re.test(route)) || [])[1] || null;

/** One row, lean, with the names it needs - null when absent or on any failure. */
async function loadOne(kind, id) {
  const def = KINDS[kind];
  if (!def || !isId(String(id))) return null;
  try {
    let q = def.model.findById(id).select(def.select);
    for (const [path, select] of def.populate || []) q = q.populate(path, select);
    return await q.lean();
  } catch {
    return null;
  }
}

/** The before picture of the write's target: { kind, doc, label }. */
async function snapshot(route, path) {
  const kind = targetKindOf(route);
  if (!kind) return null;
  const id = String(path || "")
    .split("/")
    .find((seg) => ID_RE.test(seg));
  if (!id) return null;
  const doc = await loadOne(kind, id);
  if (!doc) return null;
  let label = "";
  try {
    label = KINDS[kind].name(doc) || "";
  } catch {
    label = "";
  }
  return { kind, id, doc, label };
}

/* ───────── which body keys point at which model ───────── */

const REF_KEYS = {
  person: "Person",
  student: "Person",
  students: "Person",
  teacher: "Person",
  people: "Person",
  cycle: "Cycle",
  cycles: "Cycle",
  hostel: "Hostel",
  hostels: "Hostel",
  event: "Event",
  voucher: "Voucher",
  imageFrom: "Voucher",
  book: "Book",
  room: "Room",
  rooms: "Room",
  requiredRooms: "Room",
  subject: "Subject",
  subjects: "Subject",
  interests: "Subject",
  category: "SubjectCategory",
  account: "StaffAccount",
  supplier: "Supplier",
  profile: "Profile",
  enrollment: "Enrollment",
  lessons: "Lesson",
  intake: "Intake",
  file: "StoredFile",
  coverFile: "StoredFile",
};

/** Walks a body and collects the ids it refers to, by model. */
function collectRefs(value, into, keyHint = null, depth = 0) {
  if (value == null || depth > 3) return;
  if (typeof value === "string") {
    const kind = keyHint && REF_KEYS[keyHint];
    if (kind && isId(value)) (into[kind] = into[kind] || new Set()).add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, into, keyHint, depth + 1);
    return;
  }
  if (typeof value === "object") {
    if (value._id && keyHint && REF_KEYS[keyHint] && isId(String(value._id))) (into[REF_KEYS[keyHint]] = into[REF_KEYS[keyHint]] || new Set()).add(String(value._id));
    for (const [k, v] of Object.entries(value)) collectRefs(v, into, k, depth + 1);
  }
}

/** { "<id>": "name" } for every referenced id - one query per model. */
async function resolveNames(refs) {
  const names = {};
  await Promise.all(
    Object.entries(refs).map(async ([kind, ids]) => {
      const def = KINDS[kind];
      if (!def || !ids.size) return;
      try {
        let q = def.model.find({ _id: { $in: [...ids] } }).select(def.select);
        for (const [path, select] of def.populate || []) q = q.populate(path, select);
        for (const row of await q.lean()) {
          try {
            names[String(row._id)] = def.name(row) || "";
          } catch {
            /* a row the namer could not read */
          }
        }
      } catch {
        /* no names from this model this time */
      }
    })
  );
  return names;
}

/* ───────── words for keys and values ───────── */

const FIELD_HEB = {
  name: "שם",
  firstName: "שם פרטי",
  lastName: "שם משפחה",
  title: "כותרת",
  label: "שם",
  date: "תאריך",
  at: "מועד",
  status: "מצב",
  state: "מצב",
  note: "הערה",
  notes: "הערות",
  reason: "סיבה",
  kind: "סוג",
  stage: "שלב",
  capacity: "קיבולת",
  startDate: "התחלה",
  endDate: "סיום",
  schedule: "לוח שבועי",
  day: "יום",
  start: "משעה",
  end: "עד שעה",
  startTime: "משעה",
  endTime: "עד שעה",
  room: "חדר",
  hostel: "בית",
  hostels: "בתים",
  teacher: "מורה",
  subject: "מקצוע",
  subjects: "מקצועות",
  student: "סטודנט/ית",
  students: "סטודנטים",
  person: "אדם",
  people: "אנשים",
  cycle: "קורס",
  event: "אירוע",
  voucher: "שובר",
  book: "ספר",
  phone: "טלפון",
  email: "אימייל",
  birthDate: "תאריך לידה",
  gender: "מין",
  city: "עיר",
  address: "כתובת",
  active: "פעיל/ה",
  balance: "יתרה",
  initialValue: "ערך התחלתי",
  number: "מספר",
  price: "מחיר",
  location: "מקום",
  description: "תיאור",
  category: "קטגוריה",
  settings: "הגדרות",
  matching: "התאמה",
  availability: "זמינות",
  dueAt: "להחזרה עד",
  joinedAt: "הצטרף/ה ב",
  leftAt: "עזב/ה ב",
  registeredAt: "נרשם/ה ב",
  reservedAt: "שוריין ב",
  slotId: "מפגש",
  present: "נכח/ה",
  records: "דיווחים",
  minutes: "דקות",
  docs: "מסמכים",
  summary: "סיכום",
  fields: "שדות",
  enteredAt: "נקלט/ה ב",
  decisionNo: "מספר החלטה",
  committeeDate: "ועדת שיקום",
  calledAt: "השיחה ב",
  eligibility: "זכאות",
  interests: "תחומי עניין",
  validUntil: "בתוקף עד",
  signedAt: "נחתם ב",
  username: "שם משתמש",
  key: "מפתח",
  days: "ימים",
  month: "חודש",
  program: "תוכנית",
  mail: "מייל",
  to: "אל",
  from: "מ",
  residence: "מגורים",
  contacts: "אנשי קשר",
  isGuest: "אורח/ת",
  guest: "אורח/ת",
  progressRating: "דירוג התקדמות",
  force: "בכוח",
  allowWaitlist: "גם לרשימת המתנה",
  imageUrl: "תמונה",
  year: "שנה",
  author: "סופר/ת",
  barcode: "ברקוד",
  publisher: "הוצאה",
  pages: "עמודים",
  ageMin: "גיל מינימלי",
  ageMax: "גיל מקסימלי",
  functioningLevels: "רמות תפקוד",
  functioningLevel: "רמת תפקוד",
  groupPreference: "קבוצה / פרטני",
  format: "מתכונת",
  enrollmentOpen: "פתוח לרישום",
  requirements: "דרישות",
  requiredRooms: "חדרים הכרחיים",
  venue: "מקום המפגש",
  expiresAt: "תוקף עד",
  waiverSigned: "ויתור סודיות נחתם",
  clear: "ניקוי",
  shkediaReported: "דווח בשקדיה",
  emergencyContact: "איש קשר לחירום",
  emergencyPhone: "טלפון חירום",
  caseCoordinator: "מתאם/ת טיפול",
  pipeline: "צנרת",
  what: "מה",
  olderThanDays: "ישן מ",
  user: "משתמש",
  text: "טקסט",
  done: "בוצע",
  body: "תוכן",
  step: "שלב",
  target: "יעד",
  primary: "סיווג ראשי",
  secondary: "סיווג משני",
  actions: "פעולות",
  managerNotified: "דווח למנהל/ת",
  reportedBy: "דיווח/ה",
  coverData: "כריכה",
  removeCover: "הסרת הכריכה",
  thumb: "תמונה מוקטנת",
  imageData: "תמונה",
  imageName: "שם התמונה",
  fileName: "שם הקובץ",
  mime: "סוג הקובץ",
  size: "גודל",
  sessions: "מפגשים",
  avatar: "אווטאר",
  department: "מחלקה",
  residenceLabel: "מגורים",
  otherKind: "התוכנית השנייה",
};

const STATUS_LABELS = {
  ...D.ATTENDANCE_LABELS,
  ...D.ENROLLMENT_STATUS_LABELS,
  ...D.CYCLE_STATUS_LABELS,
  ...D.EVENT_STATUS_LABELS,
  ...D.REGISTRATION_STATUS_LABELS,
  ...D.DOCUMENT_STATUS_LABELS,
  present: "נכח/ה",
  absent: "לא הגיע/ה",
  pending: "ממתין",
  ok: "תקין",
  bad: "לא תקין",
};
const STATE_LABELS = { held: "התקיים", notHeld: "לא התקיים", taught: "התקיים", pending: "ממתין", ok: "תקין", bad: "לא תקין" };
const KIND_LABELS = Object.fromEntries([
  ...D.ACTIVITY_KINDS.map((k) => [k.key, k.label]),
  ...D.PROFILE_KINDS.map((k) => [k.key, k.label]),
  ...D.HOSTEL_KINDS.map((k) => [k.key, k.label]),
  ...D.STAFF_KINDS.map((k) => [k.key, k.label]),
  ...D.PERSON_DOCUMENT_KINDS.map((k) => [k.key, k.label]),
  ["note", "הערה"],
  ["task", "משימה"],
]);
const REASON_LABELS = Object.fromEntries([...D.ABSENCE_REASONS, ...D.LEAVE_REASONS].map((r) => [r.key, r.label]));
const CATEGORY_LABELS = Object.fromEntries([...D.EVENT_CATEGORIES, ...D.SUBJECT_CATEGORIES].map((c) => [c.key, c.label]));
const PROGRAM_LABELS = { ...D.PROGRAM_LABELS, ...D.INVOICE_ROUND_PROGRAM_LABELS, college: "מכללה לכל", culture: "תרבות לכל", hostels: "הוסטלים" };
const DOC_LABELS = Object.fromEntries(D.INTAKE_DOCUMENTS.map((d) => [d.key, d.label]));
const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const VALUE_LABELS = {
  membership: D.GYM_MEMBERSHIP_LABELS,
  status: STATUS_LABELS,
  state: STATE_LABELS,
  stage: Object.fromEntries(D.PIPELINE_STAGES.map((s) => [s.key, s.label])),
  reason: REASON_LABELS,
  kind: KIND_LABELS,
  eligibility: Object.fromEntries(D.SCREENING_ELIGIBILITY.map((e) => [e.key, e.label])),
  interests: Object.fromEntries(D.SCREENING_INTERESTS.map((i) => [i.key, i.label])),
  category: CATEGORY_LABELS,
  gender: { male: "זכר", female: "נקבה", all: "כולם", men: "גברים", women: "נשים" },
  program: PROGRAM_LABELS,
  from: PROGRAM_LABELS,
  to: PROGRAM_LABELS,
  docs: DOC_LABELS,
  key: DOC_LABELS,
  format: { Group: "קבוצתי", Private: "פרטני" },
  groupPreference: { Group: "קבוצתי", Private: "פרטני" },
  functioningLevel: D.FUNCTIONING_LABELS,
  functioningLevels: D.FUNCTIONING_LABELS,
  role: { self: "הסטודנט/ית", family: "משפחה", coordinator: "מתאם/ת", staff: "צוות" },
  what: { events: "פעולות", logins: "כניסות" },
};

let tagLabels = null; // the tags' catalogue, read once (the key → its Hebrew)
async function tagLabelsOnce() {
  if (tagLabels) return tagLabels;
  try {
    const rows = await Tag.find().select("key label").lean();
    tagLabels = Object.fromEntries(rows.map((t) => [t.key, t.label]));
  } catch {
    tagLabels = {};
  }
  return tagLabels;
}
/** A new tag row in the catalogue (a test, a migration) should be seen: the memory is short-lived. */
setInterval(() => {
  tagLabels = null;
}, 10 * 60 * 1000).unref();

const pad = (n) => String(n).padStart(2, "0");
function fmtDate(v) {
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return String(v);
  const day = `${t.getDate()}.${t.getMonth() + 1}.${String(t.getFullYear()).slice(2)}`;
  const hasTime = typeof v === "string" ? /T\d\d:\d\d/.test(v) && !/T00:00(:00)?(\.000)?Z?$/.test(v) : t.getHours() || t.getMinutes();
  return hasTime ? `${day} ${pad(t.getHours())}:${pad(t.getMinutes())}` : day;
}
const isDateish = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}|$)/.test(v);
const isMonthish = (v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

const slotText = (s, names) =>
  s && typeof s === "object"
    ? [s.day != null ? `יום ${WEEKDAYS[s.day] || s.day}` : "", s.start || s.startTime ? `${s.start || s.startTime}-${s.end || s.endTime || ""}` : "", s.room ? names[asId(s.room)] || "" : "", s.program ? PROGRAM_LABELS[s.program] || s.program : ""]
        .filter(Boolean)
        .join(" ")
    : String(s);

/** The word for a value under a key: a name, a label, a date, כן/לא, or the value itself. */
function valueText(key, v, names, depth = 0) {
  if (v === null || v === undefined || v === "") return "ריק";
  if (typeof v === "boolean") return v ? "כן" : "לא";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (names[v]) return names[v];
    if (isId(v)) return "…" + v.slice(-5);
    const map = VALUE_LABELS[key];
    if (map && map[v]) return map[v];
    if (key === "day" && /^[0-6]$/.test(v)) return `יום ${WEEKDAYS[Number(v)]}`;
    if (isMonthish(v)) return monthHe(v);
    if (isDateish(v)) return fmtDate(v);
    if (/^data:/i.test(v)) return "[תמונה]";
    return v.length > 140 ? v.slice(0, 140) + "…" : v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return "ריק";
    if (key === "schedule" || key === "availability") return v.slice(0, 6).map((s) => slotText(s, names)).join(" · ") + (v.length > 6 ? ` · ועוד ${v.length - 6}` : "");
    const items = v.slice(0, 8).map((x) => valueText(key, x, names, depth + 1));
    return items.join(", ") + (v.length > 8 ? ` ועוד ${v.length - 8}` : "");
  }
  if (typeof v === "object") {
    if (v._id && names[asId(v)]) return names[asId(v)];
    if (depth >= 2) return "{…}";
    return Object.entries(v)
      .filter(([k, x]) => x !== undefined && !SECRET.test(k))
      .slice(0, 8)
      .map(([k, x]) => `${fieldLabel(k)}: ${valueText(k, x, names, depth + 1)}`)
      .join(", ");
  }
  return String(v);
}

const fieldLabel = (k) => FIELD_HEB[k] || k;
const SECRET = /pass|token|secret|hash|signature|dataurl|base64|cookie|authorization|^by$|^thumb$/i;

/** The body as facts: one per top-level key, in words. */
function factsOf(body, names, limit = 14) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.entries(body)
    .filter(([k, v]) => v !== undefined && !SECRET.test(k))
    .slice(0, limit)
    .map(([k, v]) => ({ label: fieldLabel(k), value: valueText(k, v, names) }));
}

/* ───────── what changed (an edit against its before picture) ───────── */

const sameText = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
function norm(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") {
    if (v._id && Object.keys(v).length <= 3) return String(v._id);
    const out = {};
    for (const k of Object.keys(v).sort()) if (k !== "_id" && k !== "__v" && k !== "updatedAt") out[k] = norm(v[k]);
    return out;
  }
  if (typeof v === "string" && isDateish(v)) return new Date(v).toISOString();
  return v;
}

/** Top-level keys of the body that differ from the before picture (one level into plain objects). */
function changesOf(before, body, names) {
  if (!before || !body || typeof body !== "object" || Array.isArray(body)) return [];
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || SECRET.test(k)) continue;
    const was = before[k];
    if (sameText(was, v)) continue;
    const plain = v && typeof v === "object" && !Array.isArray(v) && was && typeof was === "object" && !Array.isArray(was) && !v._id;
    if (plain) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || SECRET.test(sk) || sameText(was[sk], sv)) continue;
        out.push({ field: `${k}.${sk}`, label: `${fieldLabel(k)} · ${fieldLabel(sk)}`, from: valueText(sk, was[sk], names), to: valueText(sk, sv, names) });
      }
    } else {
      out.push({ field: k, label: fieldLabel(k), from: valueText(k, was, names), to: valueText(k, v, names) });
    }
    if (out.length >= 12) break;
  }
  return out;
}

/* ───────── the routes with a sentence of their own ───────── */

const name = (names, v, fallback = "") => (v != null && names[asId(v)]) || fallback;
const join = (parts, sep = " · ") => parts.filter(Boolean).join(sep);

const SPECIAL = [
  [
    /^PUT \/lessons\/attendance$/,
    ({ body, names }) => {
      const records = Array.isArray(body.records) ? body.records : [];
      const counts = { Present: 0, AnnouncedAbsence: 0, Missing: 0 };
      const facts = [
        { label: "קורס", value: name(names, body.cycle, "קורס") },
        { label: "תאריך", value: body.date ? fmtDate(body.date) : "" },
      ];
      for (const r of records) {
        if (counts[r.status] !== undefined) counts[r.status] += 1;
        const who = name(names, r.student, "סטודנט/ית");
        facts.push({ label: who + (r.isGuest ? " (אורח/ת)" : ""), value: join([STATUS_LABELS[r.status] || r.status || "ריק", r.reason ? REASON_LABELS[r.reason] || r.reason : "", r.note || "", r.progressRating != null ? `דירוג ${r.progressRating}` : ""]) });
      }
      const said = join([counts.Present ? `${counts.Present} נכחו` : "", counts.AnnouncedAbsence ? `${counts.AnnouncedAbsence} לא נכחו` : "", counts.Missing ? `${counts.Missing} נעדרו` : ""]);
      return { summary: join([name(names, body.cycle, "קורס"), body.date ? fmtDate(body.date) : "", records.length === 1 ? `דיווח על ${name(names, records[0].student, "אחד")}` : `${records.length} דיווחים`, said]), facts };
    },
  ],
  [/^POST \/enrollments$/, ({ body, names }) => ({ summary: join([`${name(names, body.student, "סטודנט/ית")} ${body.status === "reserved" ? "שוריין/ה מקום ב" : "שובץ/ה ל"}${name(names, body.cycle, "קורס")}`, body.note]) })],
  [/^POST \/enrollments\/residents$/, ({ body, names, answer }) => ({ summary: join([`דיירי הבית שובצו ל${name(names, body.cycle, "קורס")}`, answer?.data?.created != null ? `${answer.data.created} שיבוצים` : ""]) })],
  [/^(PATCH|DELETE) \/enrollments\/:id$/, ({ before, names, method }) => (before ? { summary: join([`${name(names, before.student, before.label)} ב${cycleName(before.cycle) || "קורס"}`, method === "DELETE" ? "השיבוץ הוסר" : ""]) } : {})],
  [
    /^POST \/(profiles|people)\/:id\/stage$/,
    ({ body, before }) => {
      const was = before?.doc?.pipeline?.stage;
      const to = VALUE_LABELS.stage[body.stage] || body.stage || "";
      return { summary: join([before?.label, was ? `מ-${VALUE_LABELS.stage[was] || was} ל-${to}` : `לשלב ${to}`, body.note]) };
    },
  ],
  [/^POST \/people\/:id\/transfer$/, ({ body, before }) => ({ summary: join([before?.label, `מ-${PROGRAM_LABELS[body.from] || body.from || "?"} ל-${PROGRAM_LABELS[body.to] || body.to || "?"}`, body.note]) })],
  [/^POST \/event-registrations$/, ({ body, names }) => ({ summary: join([`${name(names, body.student, "סטודנט/ית")} נרשם/ה ל${name(names, body.event, "אירוע")}`, body.guest ? "אורח/ת" : "", body.reason]) })],
  [/^PATCH \/event-registrations\/:id\/attendance$/, ({ body, before }) => ({ summary: join([before?.label, body.present === true ? "הגיע/ה" : body.present === false ? "לא הגיע/ה" : "", body.note]) })],
  [/^POST \/vouchers\/:id\/grant$/, ({ body, before, names }) => ({ summary: join([`${before?.label || "השובר"} ניתן ל${name(names, body.student, "סטודנט/ית")}`, body.note]) })],
  [/^POST \/vouchers\/:id\/(redeem|revoke)$/, ({ before, route }) => ({ summary: `${before?.label || "השובר"} ${route.endsWith("redeem") ? "מומש" : "החלוקה בוטלה"}` })],
  [
    /^POST \/tags\/people\/:id$/,
    async ({ body, before }) => {
      const tag = (await tagLabelsOnce())[body.key] || body.key;
      return { summary: join([`התגית "${tag}" נוספה`, before?.label ? `ל-${before.label}` : ""], " "), facts: [{ label: "תגית", value: tag }, ...(body.note ? [{ label: "הערה", value: body.note }] : [])] };
    },
  ],
  [/^DELETE \/tags\/people\/:id\/[^/]+$/, async ({ path, before }) => ({ summary: join([`התגית "${(await tagLabelsOnce())[path.split("/").pop()] || path.split("/").pop()}" הוסרה`, before?.label ? `מ-${before.label}` : ""], " ") })],
  [/^POST \/hostel-reports\/:id\/sessions\/:id\/marks$/, ({ body, before, names }) => ({ summary: join([before?.label, `${name(names, body.person, "מישהו")}: ${STATUS_LABELS[body.status] || body.status || ""}`, body.reason ? REASON_LABELS[body.reason] || body.reason : "", body.note]) })],
  [/^POST \/hostel-reports\/:id\/sessions\/:id\/state$/, ({ body, before }) => ({ summary: join([before?.label, body.state ? `המפגש ${STATE_LABELS[body.state] || body.state}` : "המצב נמחק"]) })],
  [/^POST \/intakes\/schedule$/, ({ body, names }) => ({ summary: join([name(names, body.person, "מישהו"), body.at ? `אינטייק ב-${fmtDate(body.at)}` : "", body.note]) })],
  [/^POST \/intakes\/:id\/schedule$/, ({ body, before }) => ({ summary: join([before?.label, body.at ? `אינטייק ב-${fmtDate(body.at)}` : "", body.note]) })],
  [/^POST \/intakes\/screening$/, ({ body, names }) => ({ summary: join([name(names, body.person, "מישהו"), VALUE_LABELS.eligibility[body.eligibility] || "", Array.isArray(body.interests) ? body.interests.map((i) => VALUE_LABELS.interests[i] || i).join(", ") : "", body.note]) })],
  [/^POST \/intakes\/:id\/done$/, ({ body, before }) => ({ summary: join([before?.label, "האינטייק בוצע", body.waiverSigned ? "ויתור סודיות נחתם" : "", body.summary]) })],
  [/^PATCH \/intakes\/:id\/documents\/[^/]+$/, ({ body, before, path }) => ({ summary: join([before?.label, DOC_LABELS[path.split("/").pop()] || path.split("/").pop(), STATUS_LABELS[body.status] || body.status || "", body.validUntil ? `בתוקף עד ${fmtDate(body.validUntil)}` : "", body.note]) })],
  [/^PATCH \/intakes\/:id\/shkedia$/, ({ body, before }) => ({ summary: join([before?.label, body.clear ? "הסימון נמחק" : `נקלט/ה בשקדיה${body.enteredAt ? ` ב-${fmtDate(body.enteredAt)}` : ""}`, body.decisionNo ? `החלטה ${body.decisionNo}` : "", body.note]) })],
  [/^PATCH \/intakes\/:id\/coordinator$/, ({ body, before }) => ({ summary: join([before?.label, body.name ? `רכזת מטפלת: ${body.name}` : "הרכזת הוסרה"]) })],
  [/^PATCH \/intakes\/:id\/committee$/, ({ body, before }) => ({ summary: join([before?.label, body.committeeDate ? `ועדת שיקום ב-${fmtDate(body.committeeDate)}` : "התאריך נמחק"]) })],
  [/^POST \/intakes\/:id\/links$/, ({ body, before }) => ({ summary: join([before?.label, body.minutes ? `קישור ל-${body.minutes} דקות` : "קישור", Array.isArray(body.docs) && body.docs.length ? body.docs.map((d) => DOC_LABELS[d] || d).join(", ") : "", body.note]) })],
  [/^POST \/library\/books\/:id\/lend$/, ({ body, before, names }) => ({ summary: join([`${before?.label || "הספר"} הושאל ל${name(names, body.student, "סטודנט/ית")}`, body.dueAt ? `עד ${fmtDate(body.dueAt)}` : "", body.note]) })],
  [/^POST \/library\/loans\/:id\/extend$/, ({ body, before }) => ({ summary: join([before?.label, body.dueAt ? `הוארך עד ${fmtDate(body.dueAt)}` : ""]) })],
  [/^POST \/library\/loans\/:id\/return$/, ({ before }) => ({ summary: join([before?.label, "הספר הוחזר"]) })],
  [/^POST \/events\/:id\/(publish|cancel|done)$/, ({ before, route, body }) => ({ summary: join([before?.label, route.endsWith("publish") ? "פורסם" : route.endsWith("cancel") ? "בוטל" : "התקיים", body.reason]) })],
  [/^POST \/profiles\/:id\/(close|leave|reopen)$/, ({ before, route, body }) => ({ summary: join([before?.label, route.endsWith("close") ? "התיק נסגר" : route.endsWith("leave") ? `דיווח עזיבה${body.reason ? `: ${REASON_LABELS[body.reason] || body.reason}` : ""}` : "התיק נפתח מחדש", body.note]) })],
  [/^POST \/people$/, ({ answer }) => ({ summary: answer?.data?.person ? personName(answer.data.person) : "" })],
  [/^POST \/people\/intake$/, ({ body }) => ({ summary: join([personName(body), body.phone]) })],
  [/^POST \/accounts$/, ({ body }) => ({ summary: join([body.name, KIND_LABELS[body.kind] || body.kind, body.username]) })],
  [/^POST \/diary$/, ({ body }) => ({ summary: join([KIND_LABELS[body.kind] || "", body.title, body.date ? fmtDate(body.date) : ""]) })],
  [/^POST \/audit\/clear$/, ({ body, answer, names }) => ({ summary: join([`נמחקו ${answer?.data?.events ?? 0} פעולות ו-${answer?.data?.logins ?? 0} כניסות`, body.user ? `של ${name(names, body.user, "משתמש אחד")}` : "של כולם", body.olderThanDays ? `ישנות מ-${body.olderThanDays} יום` : "מכל הזמנים"]) })],
  // חדר כושר
  [/^POST \/gym$/, ({ body, names, answer }) => ({ summary: join([body.person ? name(names, body.person, "") : `${body.firstName || ""} ${body.lastName || ""}`.trim(), answer?.data?.revived ? "חזר/ה לחדר הכושר" : "נוסף/ה לחדר הכושר"]) })],
  [/^POST \/gym\/:id\/membership$/, ({ body, before }) => ({ summary: join([before?.label, body.membership ? D.GYM_MEMBERSHIP_LABELS[body.membership] || body.membership : "המנוי נמחק", body.note]) })],
  [/^POST \/gym\/:id\/sent$/, ({ before }) => ({ summary: join([before?.label, "הקישור להסכם נשלח בוואטסאפ"]) })],
  [/^POST \/gym\/:id\/link$/, ({ before }) => ({ summary: join([before?.label, "קישור חדש להסכם"]) })],
  [/^DELETE \/gym\/:id$/, ({ before }) => ({ summary: join([before?.label, "הוסר/ה מחדר הכושר"]) })],
];

/* ───────── the entry ───────── */

/**
 * { summary, facts, changes, label } for one write. `before` is what
 * `snapshot()` returned before the handler ran (null when there was none).
 */
async function details({ method, path, route, body, answer, before, backfill = false }) {
  // backfill (scripts/backfillAuditWords): the row is told again from its kept payload; the target's
  // picture is today's, so "what changed" cannot be known and is left empty
  const safeBody = body && typeof body === "object" ? body : {};
  const refs = {};
  collectRefs(safeBody, refs);
  if (before?.doc) collectRefs(before.doc, refs);
  if (answer && typeof answer === "object" && answer.data && typeof answer.data === "object") collectRefs(answer.data, refs, null, 2);
  const names = await resolveNames(refs);
  if (before?.id && before.label) names[before.id] = before.label;

  const facts = factsOf(safeBody, names);
  const changes = !backfill && (method === "PUT" || method === "PATCH") && before?.doc ? changesOf(before.doc, safeBody, names) : [];
  let summary = "";
  let ownFacts = null;
  const special = SPECIAL.find(([re]) => re.test(`${method} ${route}`));
  if (special) {
    try {
      const out = await special[1]({ method, path, route, body: safeBody, answer, before, names });
      summary = out?.summary || "";
      if (out?.facts) ownFacts = out.facts;
    } catch {
      summary = "";
    }
  }
  if (!summary) {
    if (changes.length) summary = changes.slice(0, 4).map((c) => `${c.label}: מ-${c.from} ל-${c.to}`).join(" · ") + (changes.length > 4 ? ` · ועוד ${changes.length - 4}` : "");
    else if (before?.label && method === "DELETE") summary = before.label;
    else summary = facts.slice(0, 5).map((f) => `${f.label}: ${f.value}`).join(" · ");
  }
  return { summary: summary.slice(0, 400), facts: (ownFacts || facts).slice(0, 40), changes, label: before?.label || "" };
}

module.exports = { details, snapshot, loadOne, targetKindOf, valueText, factsOf, changesOf, fmtDate, KINDS };
