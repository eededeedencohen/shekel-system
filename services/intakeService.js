/**
 * @file Intake service — the social worker's flow (קליטה / אינטייק) and the
 *       public sign-up page behind it
 * @module services/intakeService
 *
 * Eden's spec (2026-09-17) with the social worker's corrections
 * (2026-10-07), in code — the record carries the tags of the "קליטה אצל
 * העובדת סוציאלית" stage:
 *
 *   סטטוס עו"ס     schedule() sets the meeting (new → scheduled), markDone()
 *                  marks it held (→ done) and writes the intake activity
 *   קליטה בשקדיה   setShkedia() — the COORDINATOR entered the person in
 *                  שקדיה (date + the committee's decision number); there is
 *                  no approval that arrives from outside
 *   מסמכים         the required document rows (uploads / staff ticks), each
 *                  IN FORCE: a dated report carries the expiry typed when it
 *                  is received, the waiver is good for a year from its
 *                  signature
 *
 *   complete = held + entered in שקדיה + every required document in force,
 *   then settle():
 *     תרבות לכל profile (Interested / Intake)      → Placed
 *     מכללה לכל profile at Intake                  → AwaitingPlacement — the
 *       held seat stays reserved; the managers enter the start date and
 *       enrollmentService moves the student to Placed (an already ACTIVE
 *       seat means the date exists → Placed right away)
 *     מכללה לכל profile still at Interested/Matching (no seat yet) stays —
 *       the seat reservation will send it straight to AwaitingPlacement
 *   A file that was completed STAYS complete: a document that expires later
 *   is an alert (tags, the dashboard), never a reopened file.
 *
 *   schedule() moves a תרבות profile from Interested to Intake; a מכללה
 *   profile enters Intake only through a seat (enrollmentService).
 *
 * Her stages 1 and 3 live here too: setScreening() (the first call's
 * facts, + a "שיחה ראשונית" activity) and setCoordinator() (who owns the
 * file). The documents arrive through links: the landing page's personal
 * link (expires LANDING_LINK_HOURS after a submission) or a temporary one
 * the coordinator makes (createUploadLink, 10 minutes … 24 hours).
 *
 * One `intakes` record per person (the human is met once, whatever the
 * programs); `settle()` keeps every active student profile of the person
 * in step with it. File bytes live in the `files` collection (the server's
 * disk is wiped on every deploy); records from before 2026-10-07 may still
 * point at the disk until scripts/migrateDocsToDb.js moves them.
 *
 * Actors are persona strings (`by`) until auth exists, like the rest of
 * the pipeline; the landing page acts as LANDING_ACTOR.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Intake = require("../models/Intake");
const UploadLink = require("../models/UploadLink");
const StoredFile = require("../models/StoredFile");
const Enrollment = require("../models/Enrollment");
const Subject = require("../models/Subject");
const AppError = require("../utils/AppError");
const {
  STUDENT_KINDS,
  PROGRAM_LABELS,
  INTAKE_DOCUMENTS,
  INTAKE_REQUIRED_DOCUMENTS,
  DOCUMENT_OK_STATUSES,
  INTAKE_STAGES,
  INTAKE_FILLED_BY_KEYS,
  EVENT_CATEGORY_KEYS,
  OCCUPYING_STATUSES,
  FOLLOW_UP,
  SCREENING_ELIGIBILITY,
  SCREENING_ELIGIBILITY_KEYS,
  SCREENING_INTERESTS,
  SCREENING_INTEREST_KEYS,
  UPLOAD_LINK_MINUTES,
  LANDING_LINK_HOURS,
} = require("../utils/domain");
const { createProfile, studentProfilesOf } = require("./profileService");
const { reopenProfile } = require("./programService");
const activities = require("./activityService");

const LANDING_ACTOR = "דף הנחיתה";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/**
 * What a document may be (Eden, 2026-09-17: "תמונות מכל סוג נפוץ ו-PDF
 * ו-docs יועלו בצורה חלקה"): every common image, PDF, Word. Keyed by the
 * stored extension; `mimes` are the types browsers report for it.
 */
const FILE_KINDS = {
  pdf: ["application/pdf", "application/x-pdf"],
  jpg: ["image/jpeg", "image/jpg", "image/pjpeg"],
  png: ["image/png", "image/x-png"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  bmp: ["image/bmp", "image/x-ms-bmp"],
  tiff: ["image/tiff"],
  avif: ["image/avif"],
  heic: ["image/heic", "image/heic-sequence"],
  heif: ["image/heif", "image/heif-sequence"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
};
const EXT_ALIAS = { jpeg: "jpg", jpe: "jpg", tif: "tiff" };
const MIME_EXT = Object.fromEntries(Object.entries(FILE_KINDS).flatMap(([ext, mimes]) => mimes.map((m) => [m, ext])));
/** Types the browser shows inline; the rest (Word) are sent as downloads. */
const INLINE_MIMES = new Set(Object.entries(FILE_KINDS).filter(([ext]) => !["doc", "docx"].includes(ext)).flatMap(([, m]) => m));

/**
 * The stored kind of an upload: by the reported MIME first, by the file
 * name's extension when the browser sent nothing useful (Windows and some
 * phones report "" or application/octet-stream for HEIC / Word files).
 * → { ext, mime } or null.
 */
function fileKind(mime, fileName) {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  if (MIME_EXT[m]) return { ext: MIME_EXT[m], mime: m };
  const raw = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const ext = EXT_ALIAS[raw] || raw;
  if (ext && FILE_KINDS[ext]) return { ext, mime: FILE_KINDS[ext][0] };
  return null;
}

/* ───────────────────────── files ───────────────────────── */

/** Root of the LEGACY document store on disk — env-overridable (tests use a temp dir). */
function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
}
const fileDir = (intake) => path.join(uploadRoot(), intake.world, String(intake._id));
/** Absolute path of a document's legacy disk file (null when it is not on the disk). */
function documentPath(intake, doc) {
  if (!doc?.file?.storedName) return null;
  return path.join(fileDir(intake), doc.file.storedName);
}
/** The bytes of a document — from the `files` table, else (legacy) the disk. → { mime, name, data } | null */
async function documentFile(intake, doc) {
  if (!doc?.file) return null;
  if (doc.file.stored) {
    const f = await StoredFile.findById(doc.file.stored).select("name mime data");
    if (f) return { mime: doc.file.mime || f.mime, name: doc.file.name || f.name, data: f.data };
  }
  const p = documentPath(intake, doc);
  if (p && fs.existsSync(p)) return { mime: doc.file.mime, name: doc.file.name || doc.file.storedName, data: fs.readFileSync(p) };
  return null;
}
async function removeFile(intake, doc) {
  if (doc?.file?.stored) await StoredFile.deleteOne({ _id: doc.file.stored });
  const p = documentPath(intake, doc);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

/* ───────────────────────── checklist ───────────────────────── */

const DOC_BY_KEY = Object.fromEntries(INTAKE_DOCUMENTS.map((d) => [d.key, d]));
const rowOf = (intake, key) => (intake.documents || []).find((x) => x.key === key);
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
/** A document whose "valid until" has passed (only one that was in). */
const docExpired = (d) => DOCUMENT_OK_STATUSES.includes(d?.status) && !!d?.validUntil && new Date(d.validUntil) < startOfToday();
/**
 * Does the row satisfy its document? Waived always; received while in
 * force; a student's upload only when the document carries no validity —
 * a dated report or a signed waiver waits for the staff to confirm it
 * with its date (the social worker's rule: she types the exact expiry).
 */
function docOk(d, def) {
  if (!d) return false;
  if (d.status === "waived") return true;
  if (d.status === "received") return !docExpired(d);
  if (d.status === "uploaded") return !(def || DOC_BY_KEY[d.key])?.validity;
  return false;
}

/** Keys of the required documents that are not in (or no longer in force). */
function missingDocs(intake) {
  return INTAKE_REQUIRED_DOCUMENTS.filter((d) => !docOk(rowOf(intake, d.key), d)).map((d) => d.key);
}
/** Keys of the documents (required or not) that expired. */
function expiredDocs(intake) {
  return INTAKE_DOCUMENTS.filter((d) => docExpired(rowOf(intake, d.key))).map((d) => d.key);
}
const labelsOf = (keys) => keys.map((k) => DOC_BY_KEY[k]?.label || k);
/** What still keeps the file open, in Hebrew ("קליטה בשקדיה, דוח פסיכיאטרי"). */
function missingLabels(intake) {
  const out = [];
  if (!intake.shkedia?.enteredAt) out.push("קליטה בשקדיה");
  for (const k of missingDocs(intake)) out.push(DOC_BY_KEY[k].label + (docExpired(rowOf(intake, k)) ? " (פג תוקף)" : ""));
  return out;
}

/**
 * The record's state from its facts (the ONE definition): the meeting
 * held + entered in שקדיה + the required documents in force = complete.
 * A file that was completed stays complete (expiries are alerts).
 */
function computeStatus(intake) {
  if (intake.completedAt) return "complete";
  if (intake.done?.at) return missingDocs(intake).length || !intake.shkedia?.enteredAt ? "documents" : "complete";
  if (intake.scheduled?.at) return "scheduled";
  return "new";
}

const freshDocuments = () => INTAKE_DOCUMENTS.map((d) => ({ key: d.key, status: "missing" }));

/** The document row of a key — created on the fly for records seeded before a key existed. */
function docOf(intake, key) {
  if (!DOC_BY_KEY[key]) throw AppError.of("DOCUMENT_UNKNOWN", 400, key);
  let d = intake.documents.find((x) => x.key === key);
  if (!d) {
    intake.documents.push({ key, status: "missing" });
    d = intake.documents[intake.documents.length - 1];
  }
  return d;
}

/* ───────────────────────── helpers ───────────────────────── */

const HE_DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
/** "30.6.2027" — for dates in the log. */
function fmtDate(d) {
  const x = new Date(d);
  return `${x.getDate()}.${x.getMonth() + 1}.${x.getFullYear()}`;
}
/** "יום ג׳ 15.9 · 10:00" — for stage notes. */
function fmtHe(d) {
  const x = new Date(d);
  const hm = `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
  return `יום ${HE_DAYS[x.getDay()]} ${x.getDate()}.${x.getMonth() + 1} · ${hm}`;
}
/** The same day `months` on (the end of a shorter month when it has fewer days). */
function addMonths(d, months) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + months);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last));
  return x;
}

/**
 * Israeli phone → "05X-XXXXXXX" (or the bare digits for anything else).
 * Returns null when it cannot be a phone number at all.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+972")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  digits = digits.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 13) return null;
  if (digits.length === 10 && digits.startsWith("05")) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith("0")) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return digits;
}

const clean = (s, max = 200) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);

/** A date value → a Date, or throws (undefined / "" stays undefined). */
function parseDate(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw AppError.of("INVALID_DATE", 400);
  return d;
}

/** Find the human behind a landing submission (phone/email within the world). */
async function findPerson({ world, phone, email }) {
  const or = [];
  if (email) or.push({ email: email.toLowerCase().trim() });
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    or.push({ phone: { $in: [phone, digits, `${digits.slice(0, 3)}-${digits.slice(3)}`] } });
  }
  if (!or.length) return null;
  return Person.findOne({ world, deletedAt: null, $or: or });
}

/** The person's intake record, or null. */
function intakeOf(personId, world) {
  return Intake.findOne({ world, person: personId });
}

/** True when the person's intake is complete (enrollmentService asks). */
async function isIntakeComplete(personId, world) {
  const i = await Intake.findOne({ world, person: personId }).select("status");
  return i?.status === "complete";
}

/** Find-or-create the record (staff opened it, e.g. a walk-in). */
async function ensureIntake({ person, world, source = "staff", by }) {
  let intake = await Intake.findOne({ world, person: person._id });
  if (intake) return intake;
  intake = new Intake({ world, person: person._id, source, documents: freshDocuments() });
  if (source === "staff") intake.log.push({ action: "note", by, note: "נפתח תיק קליטה" });
  await intake.save();
  return intake;
}

/* ───────────────────────── the landing page ───────────────────────── */

/**
 * A student (or their family / coordinator) signed up on the public page.
 *   { firstName*, lastName*, phone*, email?, birthDate?, gender?, city?,
 *     residenceLabel?, emergencyContact?, emergencyPhone?, filledBy{role,name,phone}?,
 *     programs*: ["StudentCulture"|"StudentCollege"], preferences{subjects[],
 *     categories[], days[], dayParts[], notes}?, notes?, website (honeypot) }
 * Find-or-create the human (never a duplicate person), one profile per
 * chosen program at Interested (reopened when it was closed), and the
 * intake record with its personal link (good for LANDING_LINK_HOURS).
 */
async function submitLanding({ world, body = {} }) {
  if (body.website) throw AppError.of("SPAM_REJECTED", 400); // honeypot
  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  if (!firstName || !lastName) throw AppError.of("MISSING_FIELDS", 400, "שם פרטי ושם משפחה");
  const phone = normalizePhone(body.phone);
  if (!phone) throw AppError.of("INVALID_PHONE", 400);
  const email = clean(body.email, 120)?.toLowerCase();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw AppError.of("MISSING_FIELDS", 400, "אימייל לא תקין");
  const programs = [...new Set((Array.isArray(body.programs) ? body.programs : []).filter((k) => STUDENT_KINDS.includes(k)))];
  if (!programs.length) throw AppError.of("NO_PROGRAM", 400);
  const birthDate = body.birthDate ? new Date(body.birthDate) : null;
  if (birthDate && isNaN(birthDate.getTime())) throw AppError.of("INVALID_DATE", 400);
  const gender = ["male", "female", "other"].includes(body.gender) ? body.gender : undefined;

  const prefs = body.preferences || {};
  const wantSubjects = (Array.isArray(prefs.subjects) ? prefs.subjects : []).map(String).filter((s) => /^[a-f\d]{24}$/i.test(s));
  const subjects = wantSubjects.length
    ? (await Subject.find({ _id: { $in: wantSubjects }, world }).select("_id")).map((s) => s._id)
    : [];
  const categories = [...new Set((Array.isArray(prefs.categories) ? prefs.categories : []).filter((c) => EVENT_CATEGORY_KEYS.includes(c)))];
  const days = [...new Set((Array.isArray(prefs.days) ? prefs.days : []).map(Number).filter((d) => d >= 0 && d <= 6))];
  const dayParts = [...new Set((Array.isArray(prefs.dayParts) ? prefs.dayParts : []).map((p) => clean(p, 20)).filter(Boolean))];
  const prefNotes = clean(prefs.notes, 2000);
  const notes = clean(body.notes, 2000);
  const residenceLabel = clean(body.residenceLabel, 80);
  const city = clean(body.city, 80);
  const emergencyContact = clean(body.emergencyContact, 80);
  const emergencyPhone = normalizePhone(body.emergencyPhone) || undefined;
  const filledBy = {
    role: INTAKE_FILLED_BY_KEYS.includes(body.filledBy?.role) ? body.filledBy.role : "self",
    name: clean(body.filledBy?.name, 80),
    phone: normalizePhone(body.filledBy?.phone) || undefined,
  };

  // 1 · the human — never twice
  let person = await findPerson({ world, phone, email });
  const personExisted = !!person;
  if (!person) {
    person = await Person.create({
      world, firstName, lastName, phone,
      ...(email && { email }),
      ...(birthDate && { birthDate }),
      ...(gender && { gender }),
    });
  } else {
    // Fill blanks only — the staff's data wins over a re-submission.
    let touched = false;
    for (const [k, v] of Object.entries({ email, birthDate, gender })) {
      if (v && !person[k]) { person[k] = v; touched = true; }
    }
    if (touched) await person.save();
  }

  // 2 · one profile per chosen program
  const results = [];
  const pipelineNote = "נרשם/ה דרך דף הנחיתה";
  const sharedFields = { ...(emergencyContact && { emergencyContact }), ...(emergencyPhone && { emergencyPhone }), ...(notes && { notes }) };
  for (const kind of programs) {
    const fields =
      kind === "StudentCollege"
        ? { ...sharedFields, ...(subjects.length && { matching: { interests: subjects } }), ...(residenceLabel && { residence: { label: residenceLabel } }), ...(city && { city }) }
        : { ...sharedFields, ...(categories.length && { preferredCategories: categories }) };
    let profile = await Profile.findOne({ person: person._id, kind });
    if (!profile) {
      profile = await createProfile(person, kind, fields, {
        pipelineInit: { stage: "Interested", movedBy: LANDING_ACTOR, note: pipelineNote },
        opened: { by: LANDING_ACTOR, note: personExisted ? "הצטרפות לתוכנית נוספת (דף הנחיתה)" : "הרשמה בדף הנחיתה" },
      });
      results.push({ kind, created: true });
    } else if (!profile.active) {
      Object.assign(profile, fields);
      await profile.save();
      await reopenProfile({ profile, world, by: LANDING_ACTOR, note: "נרשם/ה מחדש דרך דף הנחיתה" });
      results.push({ kind, reopened: true });
    } else {
      // Already in the program — merge the preferences, touch nothing else.
      if (kind === "StudentCollege" && subjects.length) {
        const cur = (profile.matching?.interests || []).map(String);
        profile.matching = { ...(profile.matching?.toObject?.() || profile.matching || {}), interests: [...new Set([...cur, ...subjects.map(String)])] };
        await profile.save();
      }
      if (kind === "StudentCulture" && categories.length) {
        profile.preferredCategories = [...new Set([...(profile.preferredCategories || []), ...categories])];
        await profile.save();
      }
      results.push({ kind, existed: true });
    }
  }

  // 3 · the intake record + personal link (alive for a day; a re-submission renews it)
  let intake = await Intake.findOne({ world, person: person._id });
  const resubmitted = !!intake;
  if (!intake) intake = new Intake({ world, person: person._id, source: "landing", documents: freshDocuments() });
  const now = new Date();
  intake.landing = {
    ...(intake.landing?.toObject?.() || intake.landing || {}),
    submittedAt: now,
    token: intake.landing?.token || crypto.randomBytes(18).toString("base64url"),
    linkExpiresAt: new Date(now.getTime() + LANDING_LINK_HOURS * 3600000),
    filledBy,
    programs: [...new Set([...(intake.landing?.programs || []), ...programs])],
    preferences: {
      subjects: [...new Set([...(intake.landing?.preferences?.subjects || []).map(String), ...subjects.map(String)])],
      categories: [...new Set([...(intake.landing?.preferences?.categories || []), ...categories])],
      days: days.length ? days : intake.landing?.preferences?.days || [],
      dayParts: dayParts.length ? dayParts : intake.landing?.preferences?.dayParts || [],
      notes: prefNotes || intake.landing?.preferences?.notes,
    },
    residenceLabel: residenceLabel || intake.landing?.residenceLabel,
    city: city || intake.landing?.city,
    emergencyContact: emergencyContact || intake.landing?.emergencyContact,
    emergencyPhone: emergencyPhone || intake.landing?.emergencyPhone,
  };
  intake.log.push({
    action: "submitted",
    at: now,
    by: LANDING_ACTOR,
    note: `${resubmitted ? "נשלח שוב" : "נשלח"} · ${programs.map((k) => PROGRAM_LABELS[k]).join(" + ")}`,
  });
  intake.status = computeStatus(intake);
  await intake.save();

  return { person, intake, profiles: results, personExisted, resubmitted };
}

/* ───────────────────────── links ───────────────────────── */

const linkLabel = (minutes) => UPLOAD_LINK_MINUTES.find((m) => m.key === minutes)?.label || `${minutes} דקות`;

/**
 * A temporary upload link (the social worker: 10 minutes / half an hour /
 * an hour / 24 hours, locked after). `token` may come from the client —
 * then the link is known the moment the button is pressed — else it is
 * made here. `docs` narrows the page to particular documents.
 */
async function createUploadLink({ intake, minutes, docs, by, token, note }) {
  const m = Number(minutes);
  if (!UPLOAD_LINK_MINUTES.some((x) => x.key === m)) throw AppError.of("LINK_MINUTES_INVALID", 400);
  const t = typeof token === "string" && /^[\w-]{16,64}$/.test(token) ? token : crypto.randomBytes(18).toString("base64url");
  const keys = [...new Set((Array.isArray(docs) ? docs : []).filter((k) => DOC_BY_KEY[k]))];
  const link = await UploadLink.create({
    world: intake.world,
    intake: intake._id,
    token: t,
    minutes: m,
    expiresAt: new Date(Date.now() + m * 60000),
    docs: keys,
    createdBy: by,
    note: clean(note, 200),
  });
  intake.log.push({ action: "link", by, note: `נוצר קישור להעלאה ל${linkLabel(m)}${keys.length ? ` · ${labelsOf(keys).join(", ")}` : ""}` });
  await intake.save();
  return link;
}

/** The links of a record, newest first. */
const linksOf = (intake) => UploadLink.find({ intake: intake._id }).sort({ createdAt: -1 });

/**
 * What a public token opens: a temporary link (while it lives), else the
 * landing page's personal link (while it lives). → { intake, person, link }
 */
async function resolveToken({ world, token }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("INTAKE_LINK_INVALID", 404);
  const link = await UploadLink.findOne({ token: t, world });
  let intake;
  if (link) {
    if (!link.isLive()) throw AppError.of("INTAKE_LINK_EXPIRED", 410);
    intake = await Intake.findOne({ _id: link.intake, world });
    if (!intake) throw AppError.of("INTAKE_LINK_INVALID", 404);
  } else {
    intake = await Intake.findOne({ "landing.token": t, world });
    if (!intake) throw AppError.of("INTAKE_LINK_INVALID", 404);
    if (intake.landing?.linkExpiresAt && intake.landing.linkExpiresAt.getTime() < Date.now()) throw AppError.of("INTAKE_LINK_EXPIRED", 410);
  }
  const person = await Person.findById(intake.person).select("firstName");
  return { intake, person, link: link || null };
}

/* ───────────────────────── documents ───────────────────────── */

/**
 * Store a file for a document key. `data` = Buffer or base64 (data-URI
 * tolerated). A student upload (staff=false) can replace its own earlier
 * upload but never a document the staff already confirmed. A staff upload
 * counts as received — except a dated document without its `validUntil`,
 * which stays "uploaded" until the date is given; a signed one takes
 * `signedAt` (today when not given) and is good for a year.
 */
async function uploadDocument({ intake, key, fileName, mime, data, by, staff = false, validUntil, signedAt, link }) {
  const def = DOC_BY_KEY[key];
  if (!def) throw AppError.of("DOCUMENT_UNKNOWN", 400, key);
  if (!def.upload && !staff) throw AppError.of("DOCUMENT_UNKNOWN", 400, def.label);
  if (link && link.docs?.length && !link.docs.includes(key)) throw AppError.of("DOCUMENT_UNKNOWN", 400, def.label);
  const kind = fileKind(mime, fileName);
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!kind || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("DOCUMENT_INVALID", 400);
  const { ext } = kind;
  const until = def.validity === "dated" ? parseDate(validUntil) : undefined;
  const signed = def.validity === "signed" && staff ? parseDate(signedAt) || new Date() : undefined;

  const d = docOf(intake, key);
  if (!staff && d.status === "received") throw AppError.of("DOCUMENT_LOCKED", 400);

  await removeFile(intake, d);
  const name = clean(fileName, 120) || `${key}.${ext}`;
  const stored = await StoredFile.create({ world: intake.world, name, mime: kind.mime, size: buffer.length, data: buffer });
  const now = new Date();
  d.file = { name, stored: stored._id, storedName: undefined, mime: kind.mime, size: buffer.length, uploadedAt: now, by: staff ? by : "student" };
  d.note = undefined;
  const confirmed = staff && (def.validity !== "dated" || until);
  if (confirmed) {
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
    if (until) d.validUntil = until;
    if (signed) {
      d.signedAt = signed;
      d.validUntil = addMonths(signed, FOLLOW_UP.waiverMonths);
    }
  } else {
    d.status = "uploaded";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.signedAt = undefined;
    d.validUntil = undefined;
  }
  const extra = until ? ` · בתוקף עד ${fmtDate(until)}` : signed ? ` · נחתם ${fmtDate(signed)}` : "";
  intake.log.push({ action: "docUploaded", at: now, by: staff ? by : LANDING_ACTOR, note: def.label + extra });
  if (link) {
    link.usedAt.push(now);
    await link.save();
  }
  return settle(intake, staff ? by : LANDING_ACTOR);
}

/** A student pulls back their own (not yet confirmed) upload. */
async function removeStudentDocument({ intake, key }) {
  const d = docOf(intake, key);
  if (d.status === "received") throw AppError.of("DOCUMENT_LOCKED", 400);
  if (d.status !== "uploaded") return intake;
  await removeFile(intake, d);
  d.file = undefined;
  d.status = "missing";
  intake.log.push({ action: "docReset", by: LANDING_ACTOR, note: DOC_BY_KEY[key].label });
  return settle(intake, LANDING_ACTOR);
}

/**
 * Staff tick: received / waived / rejected / missing (reset — the file is
 * deleted) / comment (a reply on the document the student sees on the
 * personal link; the status stays). A dated document (דוח פסיכיאטרי) is
 * received only WITH its `validUntil` (DOCUMENT_DATE_REQUIRED); a signed
 * one (ויתור סודיות) takes `signedAt` (today when not given) and is good
 * for a year. A later tick with a new date renews either.
 */
async function setDocumentStatus({ intake, key, status, by, note, validUntil, signedAt }) {
  const d = docOf(intake, key);
  const def = DOC_BY_KEY[key];
  const label = def.label;
  const now = new Date();
  if (status === "received") {
    let extra = "";
    if (def.validity === "dated") {
      const until = parseDate(validUntil);
      if (!until) throw AppError.of("DOCUMENT_DATE_REQUIRED", 400);
      d.validUntil = until;
      extra = ` · בתוקף עד ${fmtDate(until)}`;
    } else if (def.validity === "signed") {
      const signed = parseDate(signedAt) || now;
      d.signedAt = signed;
      d.validUntil = addMonths(signed, FOLLOW_UP.waiverMonths);
      extra = ` · נחתם ${fmtDate(signed)} · בתוקף עד ${fmtDate(d.validUntil)}`;
    }
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReceived", at: now, by, note: label + extra });
  } else if (status === "comment") {
    const text = clean(note, 300);
    d.note = text;
    intake.log.push({ action: "docNote", at: now, by, note: `${label}${text ? ` · ${text}` : " · ההערה נמחקה"}` });
  } else if (status === "waived") {
    d.status = "waived";
    d.receivedAt = now;
    d.receivedBy = by;
    d.validUntil = undefined;
    d.signedAt = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docWaived", at: now, by, note: `${label}${note ? ` · ${note}` : ""}` });
  } else if (status === "rejected") {
    d.status = "rejected";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.validUntil = undefined;
    d.signedAt = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docRejected", at: now, by, note: `${label}${note ? ` · ${note}` : ""}` });
  } else if (status === "missing") {
    const hadFile = !!(d.file?.stored || d.file?.storedName);
    await removeFile(intake, d);
    d.file = undefined;
    d.status = "missing";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.validUntil = undefined;
    d.signedAt = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReset", at: now, by, note: label + (hadFile ? " · הקובץ נמחק" : "") });
  } else {
    throw AppError.of("INVALID_STATUS", 400, status);
  }
  return settle(intake, by);
}

/* ───────────────────────── her stages 1, 3 and 5 ───────────────────────── */

const eligibilityLabel = (k) => SCREENING_ELIGIBILITY.find((e) => e.key === k)?.label || k;
const interestLabel = (k) => SCREENING_INTERESTS.find((i) => i.key === k)?.label || k;

/**
 * The first call's facts (her stage 1: eligibility for סל שיקום, what the
 * person is interested in) — written on the record and as a "שיחה
 * ראשונית" activity on the person. The pipeline move itself (Interested →
 * Matching) stays the managers' button.
 */
async function setScreening({ intake, eligibility, interests, calledAt, by, note }) {
  if (eligibility !== undefined && eligibility !== null && eligibility !== "" && !SCREENING_ELIGIBILITY_KEYS.includes(eligibility)) {
    throw AppError.of("INVALID_STATUS", 400, eligibility);
  }
  const keys = [...new Set((Array.isArray(interests) ? interests : []).filter((k) => SCREENING_INTEREST_KEYS.includes(k)))];
  const at = parseDate(calledAt) || new Date();
  const text = clean(note, 2000);
  intake.screening = { calledAt: at, by, eligibility: eligibility || undefined, interests: keys, note: text };
  const parts = [eligibility ? eligibilityLabel(eligibility) : null, keys.length ? keys.map(interestLabel).join(", ") : null].filter(Boolean);
  intake.log.push({ action: "screening", at, by, note: `שיחה ראשונית${parts.length ? ` · ${parts.join(" · ")}` : ""}` });
  await intake.save();
  const activity = await activities.addActivity({
    world: intake.world,
    person: intake.person,
    kind: "firstCall",
    at,
    by,
    body: text || "",
    fields: { eligibility: eligibility || undefined, interests: keys.map(interestLabel).join(", ") },
    skipRequired: true,
  });
  return { intake, activity };
}

/** Who owns the file from here (her stage 3). An empty name clears it. */
async function setCoordinator({ intake, name, by }) {
  const who = clean(name, 80);
  const now = new Date();
  intake.coordinator = who ? { name: who, since: now, by } : undefined;
  intake.log.push({ action: "coordinator", at: now, by, note: who ? `רכזת מטפלת: ${who}` : "הרכזת המטפלת הוסרה" });
  await intake.save();
  return intake;
}

/** The rehab committee's date — the evaluation clock counts from it. */
async function setCommitteeDate({ intake, committeeDate, by }) {
  const d = parseDate(committeeDate);
  intake.committeeDate = d;
  intake.log.push({ action: "committee", by, note: d ? `תאריך ועדת שיקום: ${fmtDate(d)}` : "תאריך ועדת השיקום נמחק" });
  await intake.save();
  return intake;
}

/**
 * Entered in שקדיה (her stage 5) — the coordinator did it herself; this is
 * the record of that, with the date and the committee's decision number.
 * `clear` takes it back (a mistake).
 */
async function setShkedia({ intake, enteredAt, by, decisionNo, note, clear = false }) {
  const now = new Date();
  if (clear) {
    intake.shkedia = undefined;
    intake.log.push({ action: "shkedia", at: now, by, note: "הקליטה בשקדיה בוטלה" });
    return settle(intake, by);
  }
  const at = parseDate(enteredAt);
  if (!at) throw AppError.of("SHKEDIA_DATE_REQUIRED", 400);
  const no = clean(decisionNo, 60);
  intake.shkedia = { enteredAt: at, by, decisionNo: no, note: clean(note, 300) };
  intake.log.push({ action: "shkedia", at: now, by, note: `נקלט/ה בשקדיה · ${fmtDate(at)}${no ? ` · החלטה ${no}` : ""}` });
  return settle(intake, by);
}

/* ───────────────────────── the social worker's steps ───────────────────────── */

/**
 * The תרבות לכל profile of the person, when it is still waiting for the
 * social worker (Interested) — schedule()/markDone() move it to Intake.
 * A מכללה profile is never moved here: a reserved seat puts it at Intake.
 */
async function cultureIntoIntake(personId, by, note, moved) {
  for (const p of await studentProfilesOf(personId)) {
    if (p.kind === "StudentCulture" && p.pipeline?.stage === "Interested") {
      await p.moveToStage("Intake", by, note);
      moved.push(p.kind);
    }
  }
}

/** Set (or move) the intake meeting: "בהמתנה לאינטייק". */
async function schedule({ intake, at, by, note }) {
  if (intake.done?.at) throw AppError.of("INTAKE_ALREADY_DONE", 400);
  const when = new Date(at);
  if (!at || isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
  const first = !intake.scheduled?.at;
  const now = new Date();
  intake.scheduled = { at: when, by, note: clean(note, 500), setAt: now };
  intake.log.push({ action: first ? "scheduled" : "rescheduled", at: now, by, note: fmtHe(when) + (note ? ` · ${clean(note, 200)}` : "") });
  intake.status = computeStatus(intake);
  await intake.save();

  const moved = [];
  await cultureIntoIntake(intake.person, by, `נקבע אינטייק ל${fmtHe(when)}${note ? ` · ${clean(note, 200)}` : ""}`, moved);
  return { intake, moved };
}

/**
 * The meeting happened: "בוצע אינטייק". Ticking `waiverSigned` marks the
 * waiver received, signed at the meeting (good for a year). The summary
 * and the template's fields (רקע תפקודי, ציפיות, יעדים, גורמים מטפלים)
 * become the "אינטייק" activity on the person's record. What still keeps
 * the file open (שקדיה, documents) is written into the log.
 */
async function markDone({ intake, at, by, waiverSigned, summary, fields }) {
  if (intake.done?.at) throw AppError.of("INTAKE_ALREADY_DONE", 400);
  const when = at ? new Date(at) : new Date();
  if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
  const text = clean(summary, 4000);
  intake.done = { at: when, by, ...(waiverSigned && { waiverSignedAt: when }), summary: text };
  if (waiverSigned) {
    const waiver = docOf(intake, "waiver");
    if (!docOk(waiver, DOC_BY_KEY.waiver)) {
      waiver.status = "received";
      waiver.receivedAt = when;
      waiver.receivedBy = by;
      waiver.signedAt = when;
      waiver.validUntil = addMonths(when, FOLLOW_UP.waiverMonths);
      waiver.note = "נחתם בפגישת האינטייק";
      intake.log.push({ action: "docReceived", at: when, by, note: `${DOC_BY_KEY.waiver.label} · נחתם בפגישה · בתוקף עד ${fmtDate(waiver.validUntil)}` });
    }
  }
  const open = missingLabels(intake);
  intake.log.push({ action: "done", at: when, by, note: open.length ? `בוצע אינטייק · עוד חסר: ${open.join(", ")}` : "בוצע אינטייק" });
  const out = await settle(intake, by);
  const activity = await activities.addActivity({
    world: intake.world,
    person: intake.person,
    kind: "intake",
    at: when,
    by,
    body: text || "",
    fields: fields && typeof fields === "object" ? fields : {},
    skipRequired: true,
  });
  return { ...out, activity };
}

/**
 * Recompute the record's status and keep the person's student profiles in
 * step. Called after every document / שקדיה / meeting change.
 */
async function settle(intake, by) {
  const next = computeStatus(intake);
  intake.status = next;
  const now = new Date();
  if (next === "complete" && !intake.completedAt) {
    intake.completedAt = now;
    intake.log.push({ action: "completed", at: now, by, note: "בוצע אינטייק, נקלט/ה בשקדיה וכל המסמכים התקבלו — הקליטה הושלמה" });
  }
  await intake.save();

  const moved = [];
  if (next === "complete") {
    for (const p of await studentProfilesOf(intake.person)) {
      const stage = p.pipeline?.stage;
      if (p.kind === "StudentCulture") {
        if (["Interested", ...INTAKE_STAGES].includes(stage)) {
          await p.moveToStage("Placed", by, "הקליטה הושלמה");
          moved.push({ kind: p.kind, stage: "Placed" });
        }
        continue;
      }
      // מכללה לכל: only a profile the seat already parked with the social
      // worker moves on — the start date is the managers' step.
      if (!INTAKE_STAGES.includes(stage)) continue;
      const live = await Enrollment.find({ student: intake.person, status: { $in: OCCUPYING_STATUSES } });
      if (live.some((e) => e.status === "active")) {
        await p.moveToStage("Placed", by, "הקליטה הושלמה — השיבוץ בתוקף");
        moved.push({ kind: p.kind, stage: "Placed" });
      } else {
        await p.moveToStage("AwaitingPlacement", by, live.length ? "הקליטה הושלמה — נשאר לקבוע תאריך התחלה" : "הקליטה הושלמה — ממתין/ה לשיבוץ");
        moved.push({ kind: p.kind, stage: "AwaitingPlacement" });
      }
    }
  } else if (next === "documents" || next === "scheduled") {
    // A meeting marked held without a date set (a walk-in) still takes the
    // תרבות profile in.
    await cultureIntoIntake(intake.person, by, "בקליטה אצל העו\"ס", moved);
  }
  return { intake, moved };
}

/** Free-text note on the record (logged). */
async function addNote({ intake, by, note }) {
  const text = clean(note, 2000);
  if (!text) throw AppError.of("MISSING_FIELDS", 400, "הערה");
  intake.notes = text;
  intake.log.push({ action: "note", by, note: text.slice(0, 200) });
  await intake.save();
  return intake;
}

/* ───────────────────────── public views ───────────────────────── */

/**
 * What the student may see through a link: the uploadable documents (all
 * of them, or the ones a temporary link asked for), whether the file is
 * complete, and until when the link lives.
 */
function publicView(intake, person, link = null) {
  const only = link?.docs?.length ? new Set(link.docs) : null;
  return {
    firstName: person?.firstName || "",
    programs: intake.landing?.programs || [],
    status: intake.status,
    complete: intake.status === "complete",
    done: !!intake.done?.at,
    scheduledAt: intake.scheduled?.at || null,
    link: {
      temporary: !!link,
      expiresAt: link ? link.expiresAt : intake.landing?.linkExpiresAt || null,
    },
    documents: INTAKE_DOCUMENTS.filter((d) => d.upload && (!only || only.has(d.key))).map((d) => {
      const row = rowOf(intake, d.key);
      return {
        key: d.key, label: d.label, hint: d.hint, optional: !!d.optional,
        status: row?.status || "missing",
        fileName: row?.file?.name || null,
        uploadedAt: row?.file?.uploadedAt || null,
        validUntil: row?.validUntil || null,
        /** The document was in, and its date has passed — a new one is needed. */
        expired: docExpired(row),
        /** Uploaded, but the staff still has to confirm it with its date. */
        pending: row?.status === "uploaded" && !!d.validity,
        /** The staff's comment (a rejection reason or a reply) — the student reads it here. */
        note: row?.note || null,
      };
    }),
  };
}

module.exports = {
  LANDING_ACTOR,
  MAX_FILE_BYTES,
  fileKind,
  INLINE_MIMES,
  MIME_EXT,
  uploadRoot,
  documentPath,
  documentFile,
  docOk,
  docExpired,
  missingDocs,
  expiredDocs,
  missingLabels,
  computeStatus,
  addMonths,
  normalizePhone,
  findPerson,
  intakeOf,
  isIntakeComplete,
  ensureIntake,
  submitLanding,
  createUploadLink,
  linksOf,
  resolveToken,
  uploadDocument,
  removeStudentDocument,
  setDocumentStatus,
  setScreening,
  setCoordinator,
  setCommitteeDate,
  setShkedia,
  schedule,
  markDone,
  settle,
  addNote,
  publicView,
  fmtHe,
};
