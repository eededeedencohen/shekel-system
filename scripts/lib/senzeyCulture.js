/**
 * @file senzeyCulture — import the REAL תרבות לכל history (תשפ"ו) from the
 *       senzey exports into a world
 * @module scripts/lib/senzeyCulture
 *
 * Sources (repo root, all committed):
 *   · shekel_dashboard.html — the 26.08.2026 export embedded as `PAYLOAD`
 *     ({rows, meta}): one row per registration, `meta` per senzey "course"
 *     with the parsed title / venue / date / start / end. The newer list —
 *     canonical.
 *   · shekel_courses_2026-08-06_14-11.json — the 06.08.2026 export: the same
 *     rows with the registration SOURCE ("דף נחיתה" = the participant
 *     registered by themself on the website) and, by diffing against the
 *     newer export, the registrations that were CANCELLED in between.
 *   · drafts/clients/clients.json + Data/students/students.json — the people
 *     master data (senzey client id, phone, email, birthday, gender,
 *     emergency contact, case coordinator), joined by ID number. The ID
 *     number itself is never stored.
 *
 * Only the category "תרבות לכל (יציאות בקהילה)" is read (plus the culture
 * interest list "מתעניין/ת בתרבות לכל") — nothing of מכללה לכל is touched or
 * pulled in (Eden: "לא לדחוף מכללה לכל לדברים של תרבות לכל"). College
 * students who registered INTEREST in culture are skipped; the handful who
 * actually took part in outings as participants get a culture profile too
 * (the ERD's rare "both programs" case) — listed in the report.
 *
 * What it builds, through the real services so every invariant holds:
 *   · staff (ManagerCulture): שירן דרעי (the coordinator) + גפן בן דור
 *   · members: a StudentCulture profile (pipeline Placed, dated from the
 *     yearly umbrella registration "תרבות לכל (תשפו)"), people created or
 *     matched (senzey id → exact name) — guests get a person, no profile
 *   · one Event per dated outing (category from the title, see
 *     CATEGORY_RULES; venue; start/end; women-only where the title says so;
 *     status done/published by date) keyed by `import.senzeyCourseId`
 *   · one EventRegistration per row (self or staff as actor, the senzey
 *     timestamp, guests flagged); rows gone by 26.08 → registered then
 *     cancelled; attendance stays unreported (senzey has none)
 *   · leads: the interest list → StudentCulture at Interested
 *
 * `people: "real"` creates the actual humans (the real world); `people:
 * "fake"` (the test world) keeps the test world fake: a gender-matched
 * PSEUDONYM + "טסט" (no real name at all — senzey writes some people
 * last-first, so even a first token would leak surnames), a hashed anchor
 * instead of the senzey id, no contact details — the events, counts and
 * patterns are the real ones.
 *
 * Idempotent: every entity has an anchor (course id, person anchor,
 * {event,student}) — a second run reports and changes nothing.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Person } = require("../../models/Person");
const { Profile } = require("../../models/profiles");
const Event = require("../../models/Event");
const EventRegistration = require("../../models/EventRegistration");
const { createProfile } = require("../../services/profileService");
const culture = require("../../services/cultureService");
const { splitName, parseDate, cleanText } = require("../../utils/parsers");

const ROOT = path.join(__dirname, "..", "..", "..");
const FILES = {
  dashboard: path.join(ROOT, "shekel_dashboard.html"),
  courses: path.join(ROOT, "shekel_courses_2026-08-06_14-11.json"),
  clients: path.join(ROOT, "drafts", "clients", "clients.json"),
  students: path.join(ROOT, "Data", "students", "students.json"),
};

const CULTURE_CATEGORY = "תרבות לכל (יציאות בקהילה)";
/** "תרבות לכל (תשפו)" — the yearly membership, not an outing. */
const UMBRELLA_ID = "1231";
/** "מתעניין/ת בתרבות לכל" — the department's interest list for the program. */
const INTEREST_ID = "707";
const GUEST = "אורח/ת";
const LANDING = /דף נחיתה/;
const IMPORTER = "ייבוא סנזי";
const EXPORTED_AT = new Date("2026-08-26T12:00:00");
const SOURCE_NOTE = "יובא מסנזי (ייצוא 26.8.2026)";
const DAY = 86400000;

/** The two humans behind the "מנהל קורס" column (senzey writes them last-first). */
const STAFF = {
  "דרעי שירן": { firstName: "שירן", lastName: "דרעי", title: "רכזת תרבות לכל", primary: true },
  "גפן בן דור": { firstName: "גפן", lastName: "בן דור", title: "עובדת תרבות ופנאי", leftAt: new Date("2026-08-31T12:00:00") },
};
const PRIMARY_MANAGER = "דרעי שירן";

/* ───────────────────────── pure helpers ───────────────────────── */

/**
 * Title → category key (server/utils/domain.js EVENT_CATEGORIES). Ordered:
 * the specific kinds first, the catch-alls last. Names of performers the
 * coordinator wrote without a genre (שלומי קוריאט, גיא הוכמן = stand-up;
 * עופר שכטר, קולולם, נוקטורנו = music) are spelled out.
 */
const CATEGORY_RULES = [
  [/סטנדאפ|קוריאט|הוכמן|בדרן|קומדי/, "standup"],
  [/מחזמר/, "musical"],
  [/מחול|בלט|ריקוד/, "dance"],
  [/הצגה|הצגת|תיאטרון/, "theatre"],
  [/קונצרט|הופעה|מופע מוזיקלי|זמר|נוקטורנו|נקטורנו|זאפה|שכטר|קולולם|שירה בציבור/, "concert"],
  [/הרצאה/, "lecture"],
  [/מוזיאון|תערוכה|אקווריום/, "museum"],
  [/ערב הורים|בוקר נשים|בוצר נשים|מפגש|על האש|ערב חברתי|מועדון|יום השואה|יום הזיכרון|טקס|פרידה/, "community"],
  [/טיול|סיור|פיקניק|טבע|יער|שייט|נסיעה/, "trip"],
  [/גרג|ארומה|מוסא|מסעד|בית קפה|קפה|ארוחת|ארוחה|פיצה|המבורגר/, "restaurant"],
  [/סרט|קולנוע/, "movie"],
  [/באולינג|קריוקי|חדר בריחה|לונה פארק|משחקי/, "outing"],
  [/פסטיבל|אירוע עירוני|יריד/, "festival"],
  [/משחק|כדורגל|כדורסל|ליגה/, "sportEvent"],
  [/אימון|טניס|ספורט|כושר|ריצה|שחייה|יוגה|טורניר/, "sport"],
  [/מסיבה|מסיבת|חנוכה|פורים|חנוכייה|סוכה|ט"ו בשבט|ראש השנה|פסח|שבועות|העצמאות|יום הולדת/, "party"],
  [/סדנ|סטודיו|אומנות|אמנות|יצירה|בישול|אפיה|אפייה|פייטנות|כלבנות|סטיילינג|סטילינג|כלים|טעמי המקרא|למידת/, "workshop"],
  [/התנדבות|אריזות|חיילים/, "volunteering"],
  [/מופע|קרקס|קסמים/, "show"],
];
function categoryOfTitle(title) {
  const t = title || "";
  const hit = CATEGORY_RULES.find(([re]) => re.test(t));
  return hit ? hit[1] : "other";
}

/** Display names: the coordinator's typos and bare performer names, spelled out. */
const TITLE_FIXES = {
  "בוצר נשים": "בוקר נשים",
  "נקטורנו": "נוקטורנו — מופע מוזיקלי",
  "סדנת סטילינג עם אפרת": "סדנת סטיילינג עם אפרת",
  "עופר שכטר": "הופעה — עופר שכטר",
  "גיא הוכמן": "סטנדאפ — גיא הוכמן",
  '"שלומי קוריאט"': "סטנדאפ — שלומי קוריאט",
  'הצגה" הזוג המוזר"': 'הצגה — "הזוג המוזר"',
  'הצגה - " לנקות את הראש"': 'הצגה — "לנקות את הראש"',
};
function displayTitle(raw) {
  let t = cleanText(raw).replace(/\s+/g, " ").trim();
  if (TITLE_FIXES[t]) return TITLE_FIXES[t];
  return t.replace(/\s+-\s+/g, " — ");
}

/**
 * The venue as the app shows it: senzey's parsed venue, completed with the
 * street number the raw names carry ("יד חרוצים 9", "האומן 17") and the
 * restaurant when the title names one.
 */
function locationOf(meta, title) {
  const t = title || "";
  const v = (meta && meta.venue) || "";
  if (/גרג/.test(t)) return "קפה גרג · סינמה סיטי";
  if (/ארומה/.test(t)) return "ארומה · עמק רפאים 43";
  if (/מוסא/.test(t)) return "מסעדת מוסא · קניון מלחה";
  if (/נוקטורנו|נקטורנו/.test(t)) return "נוקטורנו · בצלאל 7";
  if (/סטודיו מדרחוב/.test(t) && (!v || /שלומציון/.test(v))) return "סטודיו מדרחוב · שלומציון המלכה 3";
  const FIX = {
    "מרכז פנאי · יד חרוצים": "מרכז פנאי · יד חרוצים 9",
    "קניון לב תלפיות": "קניון לב תלפיות · האומן 17",
    "בצלאל 7": "נוקטורנו · בצלאל 7",
    "המלך ג'ורג'": "רחוב המלך ג'ורג' 24",
    "שלומציון המלכה": "סטודיו מדרחוב · שלומציון המלכה 3",
    "הלני המלכה 3": "סטודיו מדרחוב · הלני המלכה 3",
    "סינמה סיטי": "סינמה סיטי ירושלים · דרך רבין 10",
  };
  if (v) return FIX[v] || v;
  if (/ערב הורים|בוקר נשים|סדנ|פייטנות/.test(t)) return "מרכז פנאי · יד חרוצים 9";
  return undefined;
}

/** When senzey has no start time: the program's usual hour for the kind. */
function defaultStart(category, title) {
  if (category === "theatre") return "20:15";
  if (category === "movie") return /בבוקר/.test(title) ? "11:00" : "18:30";
  if (category === "restaurant") return /צעירים/.test(title) ? "18:00" : "12:00";
  return "17:00";
}

const genderOf = (label) => (label === "זכר" ? "male" : label === "נקבה" ? "female" : label === "אחר" ? "other" : undefined);

/**
 * Pseudonyms for the test world: NO real name at all (senzey writes some
 * people last-first, so even "the first token" would leak surnames). A
 * gender-matched first name picked by hash, "טסט" as the family name, a
 * letter (נועה ב׳) when the name is already taken in the world.
 */
const FAKE_FIRST = {
  female: ["נועה", "תמר", "שירה", "מאיה", "יעל", "אביגיל", "רוני", "הילה", "מיכל", "טליה", "ליאור", "עדי", "שני", "ענבר", "אורית", "רותם", "נעמה", "הדר", "יובל", "אלה", "גלי", "דנה", "מור", "ליהי", "אגם", "אופיר", "נטע", "ניצן", "רומי", "איילת", "קרן", "ליטל", "מעיין", "שקד", "עלמה", "זהר", "סיון", "אלינור", "יסמין", "נגה", "ירדן", "לירון", "אורין", "שלי", "בר", "תהילה", "הודיה", "אביה", "אלמוג", "ליאן", "דניאלה", "טל", "מירב", "אפרת", "חן", "רוית", "מיה", "הדס", "אורנה", "רבקה"],
  male: ["יונתן", "איתי", "עומר", "דניאל", "אורי", "רועי", "אלון", "נדב", "יואב", "עידו", "אסף", "תום", "גיא", "ניר", "עמית", "אייל", "ליאם", "אריאל", "נהוראי", "איתן", "אלעד", "שחר", "מתן", "יהונתן", "בן", "רון", "דור", "אביב", "נועם", "ינון", "עילאי", "אלירן", "תומר", "גלעד", "אורן", "לביא", "יהלי", "אדם", "אופק", "רז", "שגיא", "נתנאל", "עמרי", "ברק", "דביר", "יאיר", "משה", "אבי", "אריה", "חיים", "יוסי", "דוד", "שמעון", "אלי", "נחמן", "מאיר", "ישי", "בועז", "רפאל", "צבי"],
};
const FAKE_POOL = new Set([...FAKE_FIRST.female, ...FAKE_FIRST.male]);
const SUFFIXES = ["", " ב׳", " ג׳", " ד׳", " ה׳", " ו׳", " ז׳", " ח׳", " ט׳", " י׳"];
const hashOf = (s) => parseInt(crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8), 16);
function pseudonym(spec, used) {
  const h = hashOf(spec.key);
  const pool = spec.gender === "male" ? FAKE_FIRST.male : spec.gender === "female" ? FAKE_FIRST.female : h % 2 ? FAKE_FIRST.male : FAKE_FIRST.female;
  const base = pool[h % pool.length];
  for (const s of SUFFIXES) {
    const n = base + s;
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = `${base} ${h % 97}`;
  used.add(n);
  return n;
}
/** Already a pseudonym (a pool name, optionally with a letter)? */
const isPseudonym = (firstName) => FAKE_POOL.has(String(firstName || "").replace(/ [א-ת]׳$/, "").replace(/ \d+$/, ""));
const validEmail = (s) => (s && /^\S+@\S+\.\S+$/.test(s) ? s.trim().toLowerCase() : undefined);
const anchorOf = (idn) => `senzey-test-${crypto.createHash("sha1").update(String(idn)).digest("hex").slice(0, 10)}`;
const normName = (s) => cleanText(s).replace(/\s+/g, " ").trim();
const reversedName = (s) => normName(s).split(" ").reverse().join(" ");
const localDate = (ymd, hm) => new Date(`${ymd}T${hm}:00`);

/* ───────────────────────── sources ───────────────────────── */

/** The `PAYLOAD = {...}` literal of the dashboard, parsed. */
function readPayload(file) {
  const html = fs.readFileSync(file, "utf8");
  const i = html.indexOf("PAYLOAD");
  if (i < 0) throw new Error(`PAYLOAD not found in ${file}`);
  const start = html.indexOf("=", i) + 1;
  let depth = 0, j = start, began = false, inStr = false, esc = false;
  for (; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") { depth++; began = true; }
    else if (ch === "}" || ch === "]") { depth--; if (began && depth === 0) { j++; break; } }
  }
  return JSON.parse(html.slice(start, j).trim());
}

function loadSources(files = FILES) {
  return {
    payload: readPayload(files.dashboard),
    json: JSON.parse(fs.readFileSync(files.courses, "utf8")),
    clients: JSON.parse(fs.readFileSync(files.clients, "utf8")),
    students: JSON.parse(fs.readFileSync(files.students, "utf8")),
  };
}

const rowFromHtml = (r) => ({
  courseId: String(r[0]),
  rawName: normName(r[1]),
  category: r[2],
  name: normName(r[3]),
  idn: String(r[4] || "").trim(),
  type: r[5] || "",
  manager: normName(r[8]),
  billing: r[10] || "",
  price: Number(r[11]) || 0,
  regAt: parseDate(r[12]) || null,
  source: null,
  from: "html",
});
const rowFromJson = (r) => ({
  courseId: String(r["מזהה קורס"]),
  rawName: normName(r["שם קורס"]),
  category: r["סוג קורס"],
  name: normName(r["סטודנט"]),
  idn: String(r["ת.ז."] || "").trim(),
  type: r["סוג סטודנט"] || "",
  manager: normName(r["מנהל קורס"]),
  billing: r["סוג החיוב"] || "",
  price: Number(r["מחיר"]) || 0,
  regAt: parseDate(r["תאריך הרשמה"]) || null,
  source: r["מקור רישום"] || "",
  from: "json",
});
const personKey = (row) => row.idn || `name:${row.name}`;

/**
 * Everything the importer needs, computed once from the raw files — pure,
 * so the shape can be unit-tested and dry-run without a database.
 */
function buildDataset({ payload, json, clients, students }) {
  const htmlAll = payload.rows.map(rowFromHtml);
  const jsonAll = json.records.map(rowFromJson);
  const html = htmlAll.filter((r) => r.category === CULTURE_CATEGORY);
  const jsonRows = jsonAll.filter((r) => r.category === CULTURE_CATEGORY);
  const interest = htmlAll.filter((r) => r.courseId === INTEREST_ID);

  // Registrations: the newer export wins; the older one adds the source and
  // the rows that were cancelled in between.
  const regs = new Map();
  for (const r of html) {
    const k = `${r.courseId}|${personKey(r)}`;
    const prev = regs.get(k);
    if (!prev || (r.regAt && prev.regAt && r.regAt < prev.regAt)) regs.set(k, { ...r, cancelled: false });
  }
  for (const r of jsonRows) {
    const k = `${r.courseId}|${personKey(r)}`;
    const prev = regs.get(k);
    if (prev) {
      if (prev.source == null) prev.source = r.source;
      if (!prev.regAt && r.regAt) prev.regAt = r.regAt;
    } else {
      regs.set(k, { ...r, cancelled: true });
    }
  }

  // People: everyone on a culture row; members = at least one non-guest row
  // (the umbrella counts); the rest are guests only.
  const byIdn = new Map(clients.map((c) => [String(c.identify_number || "").trim(), c]));
  const byNat = new Map(students.map((s) => [String(s.nationalId || "").trim(), s]));
  const people = new Map();
  const touch = (row) => {
    const k = personKey(row);
    if (!people.has(k)) {
      const c = row.idn ? byIdn.get(row.idn) : null;
      const s = row.idn ? byNat.get(row.idn) : null;
      const name = normName((c && c.name) || (s && s.name) || row.name);
      const { firstName, lastName } = splitName(name);
      const birthday = c && c.birthday ? parseDate(String(c.birthday).split(" ")[0]) : undefined;
      people.set(k, {
        key: k,
        name,
        firstName,
        lastName: lastName === "-" ? "" : lastName,
        clientId: (c && String(c.id)) || (s && String(s.id)) || null,
        phone: (c && c.mobile) || (s && s.phone) || undefined,
        email: validEmail(c && c.email1),
        birthDate: birthday || undefined,
        gender: genderOf(c && c.gender),
        emergencyContact: (c && c.ind_emergencyname) || (s && s.emergencyContact) || undefined,
        emergencyPhone: (c && c.ind_emergencyphone2) || (s && s.emergencyPhone) || undefined,
        coordinator: {
          name: (c && c.ind_coordinator) || (s && s.coordinatorName) || undefined,
          phone: (c && c.ind_coordinator_phone) || (s && s.coordinatorPhone) || undefined,
          organization: (c && c.ind_coordinator_organization) || (s && s.coordinatorOrganization) || undefined,
        },
        framework: (c && c.ind_misgeret) || (s && s.framework) || undefined,
        residence: (c && c.ind_residence) || (s && s.residence) || undefined,
        statusLabel: (c && c.client_status) || (s && s.status) || undefined,
        clientType: (c && c.client_type) || (s && s.clientType) || row.type || undefined,
        member: false,
        joinAt: null,
        firstRegAt: null,
        interestAt: null,
        billing: null,
        rows: 0,
      });
    }
    return people.get(k);
  };
  for (const r of regs.values()) {
    const p = touch(r);
    p.rows++;
    if (r.type !== GUEST) p.member = true;
    if (r.courseId === UMBRELLA_ID) {
      if (r.regAt && (!p.joinAt || r.regAt < p.joinAt)) p.joinAt = r.regAt;
      if (r.price > 0) p.billing = `${r.billing} ${r.price.toFixed(2)}`.trim();
    } else if (r.regAt && (!p.firstRegAt || r.regAt < p.firstRegAt)) {
      p.firstRegAt = r.regAt;
    }
  }
  for (const r of interest) {
    const p = touch(r);
    if (r.regAt && (!p.interestAt || r.regAt < p.interestAt)) p.interestAt = r.regAt;
    p.interested = true;
  }

  // Courses → dated outings (the umbrella and the weekly groups are skipped).
  const courses = new Map();
  const skipped = [];
  const byCourse = new Map();
  for (const r of regs.values()) {
    if (!byCourse.has(r.courseId)) byCourse.set(r.courseId, []);
    byCourse.get(r.courseId).push(r);
  }
  for (const [id, rows] of byCourse) {
    const meta = payload.meta[id] || {};
    const live = rows.filter((r) => !r.cancelled);
    if (id === UMBRELLA_ID) { skipped.push({ id, name: rows[0].rawName, why: "החברות השנתית — הופכת לפרופילים, לא לאירוע", rows: live.length }); continue; }
    if (meta.kind !== "event" || !meta.date) { skipped.push({ id, name: rows[0].rawName, why: `קבוצה שבועית בלי תאריך (${meta.kind || "?"})`, rows: live.length }); continue; }
    const title = displayTitle(meta.title || rows[0].rawName);
    const category = categoryOfTitle(meta.title || rows[0].rawName);
    const start = meta.start || defaultStart(category, title);
    const managers = new Map();
    for (const r of rows) managers.set(r.manager, (managers.get(r.manager) || 0) + 1);
    const manager = [...managers.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const billing = new Map();
    for (const r of rows) billing.set(r.billing, (billing.get(r.billing) || 0) + 1);
    const times = rows.map((r) => r.regAt).filter(Boolean).sort((a, b) => a - b);
    courses.set(id, {
      id,
      rawName: rows[0].rawName,
      title,
      category,
      date: localDate(meta.date, start),
      endTime: meta.end || undefined,
      startGuessed: !meta.start,
      location: locationOf(meta, meta.title || rows[0].rawName),
      gender: /נשים/.test(title) ? "women" : "all",
      manager,
      billingLabel: [...billing.entries()].sort((a, b) => b[1] - a[1])[0][0] || undefined,
      firstRegAt: times[0] || null,
      rows,
    });
  }
  const members = [...people.values()].filter((p) => p.member);
  const guestsOnly = [...people.values()].filter((p) => !p.member && p.rows > 0);
  const leads = [...people.values()].filter((p) => !p.member && p.interested);
  return { regs, people, members, guestsOnly, leads, courses, skipped, managers: new Set([...regs.values()].map((r) => r.manager)) };
}

/* ───────────────────────── import ───────────────────────── */

/**
 * @param {object} o
 * @param {"real"|"test"|"pokemon"} o.world
 * @param {"real"|"fake"} [o.people]  real humans (contact details, senzey id)
 *        or the test world's fake stand-ins (first name + "טסט", hashed anchor)
 * @param {boolean} [o.dry]        report only
 * @param {boolean} [o.reset]      delete previously imported events + their registrations first
 * @param {boolean} [o.interest]   also import the interest list as leads (default true)
 * @param {Function} [o.log]
 * @param {object}  [o.files]      override the source paths (tests)
 */
async function importCultureSenzey({ world, people = world === "real" ? "real" : "fake", dry = false, reset = false, interest = true, log = console.log, files = FILES }) {
  const fake = people === "fake";
  const ds = buildDataset(loadSources(files));
  const report = {
    world, people, dry,
    staff: { created: 0, existing: 0 },
    persons: { created: 0, matchedBySenzeyId: 0, matchedByName: 0, existing: 0, byName: [] },
    profiles: { members: 0, membersExisting: 0, bothPrograms: [], leads: 0, leadsExisting: 0, leadsSkippedCollege: [] },
    events: { created: 0, updated: 0, skipped: ds.skipped },
    registrations: { created: 0, cancelled: 0, existing: 0, guests: 0, self: 0, forced: 0, failed: [] },
    categories: {},
    guessedTimes: [],
    unmatchedMaster: [],
  };
  for (const c of ds.courses.values()) report.categories[c.category] = (report.categories[c.category] || 0) + 1;
  for (const c of ds.courses.values()) if (c.startGuessed) report.guessedTimes.push(`${c.id} ${c.title} → ${c.date.toTimeString().slice(0, 5)}`);
  for (const p of ds.people.values()) if (!p.clientId) report.unmatchedMaster.push(p.name);

  if (reset && !dry) {
    const ids = (await Event.find({ world, "import.senzeyCourseId": { $exists: true } }).select("_id")).map((e) => e._id);
    const r1 = await EventRegistration.deleteMany({ world, event: { $in: ids } });
    const r2 = await Event.deleteMany({ _id: { $in: ids } });
    log(`reset: removed ${r2.deletedCount} imported events and ${r1.deletedCount} registrations in ${world}`);
  }

  /* ── staff ─────────────────────────────────────────────────── */
  const staffPersons = new Map(); // manager string → Person (with an ACTIVE ManagerCulture profile)
  const existingStaff = await Profile.find({ world, kind: "ManagerCulture" }).populate("person", "firstName lastName").lean();
  for (const [manager, spec] of Object.entries(STAFF)) {
    let hit = existingStaff.find((p) => p.person && p.person.firstName === spec.firstName && (fake || p.person.lastName === spec.lastName));
    if (hit && hit.active !== false) { staffPersons.set(manager, hit.person); report.staff.existing++; continue; }
    if (hit && hit.active === false) { report.staff.existing++; continue; } // left — their rows fall back to the coordinator
    if (dry) { report.staff.created++; continue; }
    const person = await Person.create({ world, firstName: spec.firstName, lastName: fake ? "טסט" : spec.lastName });
    await createProfile(person, "ManagerCulture", { title: spec.title }, { trusted: true, opened: { by: IMPORTER, note: SOURCE_NOTE, at: new Date("2025-09-01T09:00:00") } });
    staffPersons.set(manager, person);
    report.staff.created++;
  }
  const primary = staffPersons.get(PRIMARY_MANAGER) || [...staffPersons.values()][0];
  const actorFor = (manager) => staffPersons.get(manager) || primary;
  if (!primary && !dry) throw new Error("no culture staff to act as — cannot import");

  /* ── people ────────────────────────────────────────────────── */
  const all = await Person.find({ world, deletedAt: null }).select("firstName lastName senzeyId email").lean();
  const bySenzey = new Map(all.filter((p) => p.senzeyId).map((p) => [p.senzeyId, p]));
  const byName = new Map();
  for (const p of all) {
    const full = normName(`${p.firstName} ${p.lastName || ""}`);
    if (!byName.has(full)) byName.set(full, p);
  }
  const emails = new Set(all.map((p) => p.email).filter(Boolean));
  const usedFirst = new Set(all.filter((p) => p.lastName === "טסט").map((p) => p.firstName));
  const collegeOf = new Set((await Profile.find({ world, kind: "StudentCollege", active: true }).select("person").lean()).map((p) => String(p.person)));
  const cultureOf = new Set((await Profile.find({ world, kind: "StudentCulture" }).select("person").lean()).map((p) => String(p.person)));
  const resolved = new Map(); // person key → Person doc (or null in dry)

  const resolvePerson = async (spec) => {
    if (resolved.has(spec.key)) return resolved.get(spec.key);
    let person = null;
    if (fake) {
      const anchor = anchorOf(spec.key);
      person = bySenzey.get(anchor) || null;
      if (person) {
        report.persons.existing++;
        // Repair: an earlier import named stand-ins after the senzey first
        // token — replace anything that is not one of our pseudonyms.
        if (!isPseudonym(person.firstName) && !dry) {
          const firstName = pseudonym(spec, usedFirst);
          await Person.updateOne({ _id: person._id }, { $set: { firstName } });
          person.firstName = firstName;
          report.persons.renamed = (report.persons.renamed || 0) + 1;
        }
      } else if (!dry) {
        person = await Person.create({ world, firstName: pseudonym(spec, usedFirst), lastName: "טסט", senzeyId: anchor, ...(spec.gender && { gender: spec.gender }) });
        bySenzey.set(anchor, person);
        report.persons.created++;
      } else report.persons.created++;
    } else {
      if (spec.clientId && bySenzey.has(spec.clientId)) { person = bySenzey.get(spec.clientId); report.persons.matchedBySenzeyId++; }
      else if (byName.has(spec.name) || byName.has(reversedName(spec.name))) {
        person = byName.get(spec.name) || byName.get(reversedName(spec.name));
        report.persons.matchedByName++;
        report.persons.byName.push(spec.name);
        if (spec.clientId && !person.senzeyId && !dry) {
          await Person.updateOne({ _id: person._id }, { $set: { senzeyId: spec.clientId } });
          bySenzey.set(spec.clientId, person);
        }
      } else if (!dry) {
        const email = spec.email && !emails.has(spec.email) ? spec.email : undefined;
        if (email) emails.add(email);
        person = await Person.create({
          world,
          firstName: spec.firstName,
          lastName: spec.lastName,
          ...(spec.clientId && { senzeyId: spec.clientId }),
          ...(spec.phone && { phone: spec.phone }),
          ...(email && { email }),
          ...(spec.birthDate && { birthDate: spec.birthDate }),
          ...(spec.gender && { gender: spec.gender }),
        });
        if (spec.clientId) bySenzey.set(spec.clientId, person);
        byName.set(spec.name, person);
        report.persons.created++;
      } else report.persons.created++;
    }
    resolved.set(spec.key, person);
    return person;
  };

  const profileFieldsOf = (spec, stage, history, since, note) => ({
    pipeline: { stage, since: history[history.length - 1].movedAt },
    stageHistory: history,
    since,
    log: [{ event: "opened", at: since, by: IMPORTER, note }],
    ...(spec.emergencyContact && { emergencyContact: spec.emergencyContact }),
    ...(spec.emergencyPhone && { emergencyPhone: spec.emergencyPhone }),
    ...(!fake && spec.coordinator.name && { caseCoordinator: spec.coordinator }),
    ...(spec.billing && { billingNotes: `דמי חבר תשפ״ו: ${spec.billing}` }),
    import: {
      statusLabel: spec.statusLabel,
      clientType: spec.clientType,
      ...(!fake && spec.framework && { framework: spec.framework }),
      ...(!fake && spec.residence && { residence: spec.residence }),
      source: SOURCE_NOTE,
    },
  });

  /* ── members → StudentCulture (Placed) ─────────────────────── */
  for (const spec of ds.members) {
    const person = await resolvePerson(spec);
    if (person && cultureOf.has(String(person._id))) { report.profiles.membersExisting++; continue; }
    const join = spec.joinAt || spec.firstRegAt || new Date("2025-09-01T09:00:00");
    const history = [];
    if (spec.interestAt && spec.interestAt < join) history.push({ stage: "Interested", movedBy: IMPORTER, movedAt: spec.interestAt, note: "נרשם/ה לרשימת המתעניינים בתרבות לכל (סנזי)" });
    history.push({ stage: "Placed", movedBy: IMPORTER, movedAt: join, note: "רשום/ה לתרבות לכל תשפ״ו (סנזי)" });
    const both = person && collegeOf.has(String(person._id));
    if (both) report.profiles.bothPrograms.push(spec.name);
    if (!dry) {
      try {
        const prof = await createProfile(person, "StudentCulture", {
          ...profileFieldsOf(spec, "Placed", history, history[0].movedAt, both ? "משתתף/ת באירועי תרבות לכל בנוסף למכללה (סנזי)" : "חבר/ה בתרבות לכל תשפ״ו (סנזי)"),
          ...(both && { notes: "סטודנט/ית מכללה לכל שמשתתף/ת גם באירועי תרבות לכל" }),
        }, { trusted: true });
        cultureOf.add(String(prof.person));
      } catch (e) {
        if (e.code !== "PROFILE_EXISTS") throw e;
        report.profiles.membersExisting++;
        continue;
      }
    }
    report.profiles.members++;
  }
  // guests-only: a person, no profile
  for (const spec of ds.guestsOnly) await resolvePerson(spec);

  /* ── events + registrations ────────────────────────────────── */
  const courses = [...ds.courses.values()].sort((a, b) => a.date - b.date);
  for (const c of courses) {
    const staff = actorFor(c.manager);
    const createdAt = new Date((c.firstRegAt ? c.firstRegAt.getTime() : c.date.getTime() - 21 * DAY) - 3 * DAY);
    const publishedAt = new Date(createdAt.getTime() + DAY);
    const notes = [SOURCE_NOTE, c.startGuessed ? "השעה לא צוינה בסנזי — הוזנה שעה משוערת" : null].filter(Boolean).join(" · ");
    const mutable = {
      name: c.title,
      category: c.category,
      ...(c.location && { location: c.location }),
      ...(c.endTime && { endTime: c.endTime }),
      "settings.gender": c.gender,
      notes,
      "import.senzeyName": c.rawName,
      ...(c.billingLabel && { "import.billingLabel": c.billingLabel }),
    };
    let event = await Event.findOne({ world, "import.senzeyCourseId": c.id });
    if (event) {
      if (!dry) await Event.updateOne({ _id: event._id }, { $set: mutable });
      report.events.updated++;
    } else if (dry) {
      report.events.created++;
      report.registrations.created += c.rows.filter((r) => !r.cancelled).length;
      report.registrations.cancelled += c.rows.filter((r) => r.cancelled).length;
      report.registrations.guests += c.rows.filter((r) => r.type === GUEST).length;
      report.registrations.self += c.rows.filter((r) => r.type !== GUEST && LANDING.test(r.source || "")).length;
      continue;
    } else {
      event = await Event.create({
        world,
        name: c.title,
        date: c.date,
        ...(c.endTime && { endTime: c.endTime }),
        category: c.category,
        ...(c.location && { location: c.location }),
        settings: { gender: c.gender },
        price: 0,
        status: c.date.getTime() < Date.now() ? "done" : "published",
        created: { by: staff._id, at: createdAt },
        published: { by: staff._id, at: publishedAt },
        notes,
        import: { senzeyCourseId: c.id, senzeyName: c.rawName, ...(c.billingLabel && { billingLabel: c.billingLabel }) },
      });
      report.events.created++;
    }
    if (dry) continue;

    const existing = new Set((await EventRegistration.find({ event: event._id }).select("student").lean()).map((r) => String(r.student)));
    for (const r of c.rows) {
      const spec = ds.people.get(personKey(r));
      const person = await resolvePerson(spec);
      if (!person) continue;
      if (existing.has(String(person._id))) { report.registrations.existing++; continue; }
      const isGuest = r.type === GUEST;
      const self = !isGuest && LANDING.test(r.source || "");
      const at = r.regAt || new Date(c.date.getTime() - 7 * DAY);
      const reason = isGuest ? "אורח/ת (סנזי)" : self ? "נרשם/ה דרך דף הנחיתה של תרבות לכל (סנזי)" : "נרשם/ה ע\"י הרכזת (סנזי)";
      const base = { eventId: event._id, studentId: person._id, world, reason, at, trusted: true, guest: isGuest };
      let reg;
      try {
        reg = await culture.register({ ...base, by: self ? person._id : actorFor(r.manager)._id });
      } catch (e) {
        if (e.code === "NOT_ELIGIBLE" || e.code === "NOT_CULTURE_STUDENT") {
          try {
            reg = await culture.register({ ...base, by: actorFor(r.manager)._id, force: true, guest: isGuest || e.code === "NOT_CULTURE_STUDENT" });
            report.registrations.forced++;
          } catch (e2) {
            report.registrations.failed.push(`${c.id} ${spec.name}: ${e2.code || e2.message}`);
            continue;
          }
        } else if (e.code === "DUPLICATE_REGISTRATION") { report.registrations.existing++; continue; }
        else { report.registrations.failed.push(`${c.id} ${spec.name}: ${e.code || e.message}`); continue; }
      }
      existing.add(String(person._id));
      report.registrations.created++;
      if (isGuest) report.registrations.guests++;
      if (self) report.registrations.self++;
      if (r.cancelled) {
        const cancelAt = c.date.getTime() < EXPORTED_AT.getTime() ? new Date(c.date.getTime() - DAY) : EXPORTED_AT;
        await culture.cancelRegistration({ registrationId: reg._id, world, by: actorFor(r.manager)._id, reason: "בוטל בסנזי לפני ייצוא 26.8.2026", at: cancelAt });
        report.registrations.cancelled++;
      }
    }
  }

  /* ── leads → StudentCulture (Interested) ───────────────────── */
  if (interest) {
    for (const spec of ds.leads) {
      const person = await resolvePerson(spec);
      if (person && collegeOf.has(String(person._id))) { report.profiles.leadsSkippedCollege.push(spec.name); continue; }
      if (person && cultureOf.has(String(person._id))) { report.profiles.leadsExisting++; continue; }
      const at = spec.interestAt || new Date("2026-02-01T10:00:00");
      const history = [{ stage: "Interested", movedBy: IMPORTER, movedAt: at, note: "נרשם/ה לרשימת המתעניינים בתרבות לכל (סנזי)" }];
      if (!dry) {
        try {
          const prof = await createProfile(person, "StudentCulture", profileFieldsOf(spec, "Interested", history, at, "מתעניין/ת בתרבות לכל (סנזי)"), { trusted: true });
          cultureOf.add(String(prof.person));
        } catch (e) {
          if (e.code !== "PROFILE_EXISTS") throw e;
          report.profiles.leadsExisting++;
          continue;
        }
      }
      report.profiles.leads++;
    }
  }

  /* ── the second hand left the department (real world only) ── */
  if (!fake && !dry) {
    for (const [manager, spec] of Object.entries(STAFF)) {
      if (!spec.leftAt) continue;
      const person = staffPersons.get(manager);
      if (!person) continue;
      const prof = await Profile.findOne({ world, kind: "ManagerCulture", person: person._id });
      if (prof && prof.active !== false) {
        prof.active = false;
        prof.until = spec.leftAt;
        prof.log.push({ event: "closed", at: spec.leftAt, by: IMPORTER, note: "סיימה את תפקידה (מסיבת פרידה, אוגוסט 2026)" });
        await prof.save();
      }
    }
  }
  return report;
}

/** Human-readable summary of a report. */
function formatReport(r) {
  const lines = [];
  lines.push(`${r.dry ? "[dry] " : ""}world ${r.world} · people ${r.people}`);
  lines.push(`staff: ${r.staff.created} created, ${r.staff.existing} existing`);
  lines.push(`persons: ${r.persons.created} created · matched by senzey id ${r.persons.matchedBySenzeyId} · by name ${r.persons.matchedByName}${r.persons.byName.length ? ` (${r.persons.byName.join(", ")})` : ""} · existing anchors ${r.persons.existing}${r.persons.renamed ? ` (${r.persons.renamed} stand-ins renamed to pseudonyms)` : ""}`);
  lines.push(`members: ${r.profiles.members} profiles (${r.profiles.membersExisting} already) · both programs: ${r.profiles.bothPrograms.length ? r.profiles.bothPrograms.join(", ") : "none"}`);
  lines.push(`leads: ${r.profiles.leads} (${r.profiles.leadsExisting} already) · skipped college students: ${r.profiles.leadsSkippedCollege.length ? r.profiles.leadsSkippedCollege.join(", ") : "none"}`);
  lines.push(`events: ${r.events.created} created, ${r.events.updated} updated · categories: ${Object.entries(r.categories).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" · ")}`);
  lines.push(`skipped courses: ${r.events.skipped.map((s) => `${s.id} ${s.name} (${s.why}, ${s.rows} rows)`).join(" | ") || "none"}`);
  lines.push(`registrations: ${r.registrations.created} created (${r.registrations.self} self-service, ${r.registrations.guests} guests, ${r.registrations.forced} forced past eligibility) · ${r.registrations.cancelled} cancelled · ${r.registrations.existing} existing`);
  if (r.registrations.failed.length) lines.push(`FAILED: ${r.registrations.failed.join(" | ")}`);
  lines.push(`guessed start times: ${r.guessedTimes.join(" | ") || "none"}`);
  lines.push(`people without a master record (name only): ${r.unmatchedMaster.join(", ") || "none"}`);
  return lines.join("\n");
}

module.exports = {
  FILES, CULTURE_CATEGORY, UMBRELLA_ID, INTEREST_ID, CATEGORY_RULES, TITLE_FIXES,
  categoryOfTitle, displayTitle, locationOf, defaultStart, readPayload, loadSources, buildDataset,
  pseudonym, isPseudonym, importCultureSenzey, formatReport,
};
