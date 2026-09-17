/**
 * @file Intake service — the social worker's flow (קליטה / אינטייק) and the
 *       public sign-up page behind it
 * @module services/intakeService
 *
 * Eden's spec (2026-09-17), in code — the record carries the three tags
 * of the "קליטה אצל העובדת סוציאלית" stage:
 *
 *   סטטוס עו"ס   schedule() sets the meeting (new → scheduled), markDone()
 *                marks it held (→ done)
 *   אישור שקדייה the `shkedia` approval row (received / waived by staff)
 *   מסמכים       the four document rows (uploads / staff ticks)
 *
 *   complete = held + approval in + all four documents in, then settle():
 *     תרבות לכל profile (Interested / Intake)      → Placed
 *     מכללה לכל profile at Intake                  → AwaitingPlacement — the
 *       held seat stays reserved; the managers enter the start date and
 *       enrollmentService moves the student to Placed (an already ACTIVE
 *       seat means the date exists → Placed right away)
 *     מכללה לכל profile still at Interested/Matching (no seat yet) stays —
 *       the seat reservation will send it straight to AwaitingPlacement
 *
 *   schedule() moves a תרבות profile from Interested to Intake; a מכללה
 *   profile enters Intake only through a seat (enrollmentService).
 *
 * One `intakes` record per person (the human is met once, whatever the
 * programs); `settle()` keeps every active student profile of the person
 * in step with it. Files live under UPLOAD_DIR/<world>/<intakeId>/ — the
 * record keeps the metadata only.
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
const Enrollment = require("../models/Enrollment");
const Subject = require("../models/Subject");
const AppError = require("../utils/AppError");
const {
  STUDENT_KINDS,
  PROGRAM_LABELS,
  INTAKE_DOCUMENTS,
  INTAKE_REQUIRED_DOCUMENTS,
  INTAKE_APPROVALS,
  DOCUMENT_OK_STATUSES,
  INTAKE_STAGES,
  INTAKE_FILLED_BY_KEYS,
  EVENT_CATEGORY_KEYS,
  OCCUPYING_STATUSES,
} = require("../utils/domain");
const { createProfile, studentProfilesOf } = require("./profileService");
const { reopenProfile } = require("./programService");

const LANDING_ACTOR = "דף הנחיתה";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MIME_EXT = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/* ───────────────────────── files ───────────────────────── */

/** Root of the document store — env-overridable (tests use a temp dir). */
function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
}
const fileDir = (intake) => path.join(uploadRoot(), intake.world, String(intake._id));
/** Absolute path of a document's stored file (null when none). */
function documentPath(intake, doc) {
  if (!doc?.file?.storedName) return null;
  return path.join(fileDir(intake), doc.file.storedName);
}
function removeFile(intake, doc) {
  const p = documentPath(intake, doc);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

/* ───────────────────────── checklist ───────────────────────── */

const DOC_BY_KEY = Object.fromEntries(INTAKE_DOCUMENTS.map((d) => [d.key, d]));
const docOk = (d) => DOCUMENT_OK_STATUSES.includes(d?.status);
const rowOf = (intake, key) => (intake.documents || []).find((x) => x.key === key);
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
/** A received approval past its "valid until" date no longer counts. */
const approvalExpired = (d) => d?.status === "received" && d.validUntil && new Date(d.validUntil) < startOfToday();
/** An approval counts only once the office confirmed it WITH its date (or waived it) — a bare upload does not. */
const approvalOk = (d) => (d?.status === "received" && !approvalExpired(d)) || d?.status === "waived";

/** Keys of the four documents that are not in yet. */
function missingDocs(intake) {
  return INTAKE_REQUIRED_DOCUMENTS.filter((d) => !docOk(rowOf(intake, d.key))).map((d) => d.key);
}
/** Keys of the approvals (אישור שקדייה) that are not in — or expired. */
function missingApprovals(intake) {
  return INTAKE_APPROVALS.filter((d) => !approvalOk(rowOf(intake, d.key))).map((d) => d.key);
}
const labelsOf = (keys) => keys.map((k) => DOC_BY_KEY[k].label);
/** What still keeps the file open, in Hebrew ("אישור שקדייה, דוח פסיכיאטרי"). */
const missingLabels = (intake) => labelsOf([...missingApprovals(intake), ...missingDocs(intake)]);

/**
 * The record's state from its facts (the ONE definition): the meeting
 * held + the approval in + the four documents in = complete.
 */
function computeStatus(intake) {
  if (intake.done?.at) return missingDocs(intake).length || missingApprovals(intake).length ? "documents" : "complete";
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
/** "30.6.2027" — for approval dates in the log. */
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
 * intake record with its personal link.
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

  // 3 · the intake record + personal link
  let intake = await Intake.findOne({ world, person: person._id });
  const resubmitted = !!intake;
  if (!intake) intake = new Intake({ world, person: person._id, source: "landing", documents: freshDocuments() });
  const now = new Date();
  intake.landing = {
    ...(intake.landing?.toObject?.() || intake.landing || {}),
    submittedAt: now,
    token: intake.landing?.token || crypto.randomBytes(18).toString("base64url"),
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

/* ───────────────────────── documents ───────────────────────── */

/** A "valid until" value → a Date at local midnight, or throws (undefined stays undefined). */
function parseValidUntil(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw AppError.of("INVALID_DATE", 400);
  return d;
}

/**
 * Store a file for a document key. `data` = Buffer or base64 (data-URI
 * tolerated). A student upload (staff=false) can replace its own earlier
 * upload but never a document the staff already confirmed. A staff upload
 * counts as received — except an approval without its `validUntil`, which
 * stays "uploaded" until the date is given.
 */
async function uploadDocument({ intake, key, fileName, mime, data, by, staff = false, validUntil }) {
  const def = DOC_BY_KEY[key];
  if (!def) throw AppError.of("DOCUMENT_UNKNOWN", 400, key);
  if (!def.upload && !staff) throw AppError.of("DOCUMENT_UNKNOWN", 400, def.label);
  const ext = MIME_EXT[String(mime || "").toLowerCase()];
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!ext || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("DOCUMENT_INVALID", 400);
  const until = def.approval ? parseValidUntil(validUntil) : undefined;

  const d = docOf(intake, key);
  if (!staff && d.status === "received") throw AppError.of("DOCUMENT_LOCKED", 400);

  fs.mkdirSync(fileDir(intake), { recursive: true });
  removeFile(intake, d);
  const storedName = `${key}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(fileDir(intake), storedName), buffer);
  const now = new Date();
  d.file = { name: clean(fileName, 120) || `${key}.${ext}`, storedName, mime: mime.toLowerCase(), size: buffer.length, uploadedAt: now, by: staff ? by : "student" };
  d.note = undefined;
  if (staff && (!def.approval || until)) {
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
    if (until) d.validUntil = until;
  } else {
    d.status = "uploaded";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
  }
  intake.log.push({ action: "docUploaded", at: now, by: staff ? by : LANDING_ACTOR, note: def.label + (until ? ` · בתוקף עד ${fmtDate(until)}` : "") });
  return settle(intake, staff ? by : LANDING_ACTOR);
}

/** A student pulls back their own (not yet confirmed) upload. */
async function removeStudentDocument({ intake, key }) {
  const d = docOf(intake, key);
  if (d.status === "received") throw AppError.of("DOCUMENT_LOCKED", 400);
  if (d.status !== "uploaded") return intake;
  removeFile(intake, d);
  d.file = undefined;
  d.status = "missing";
  intake.log.push({ action: "docReset", by: LANDING_ACTOR, note: DOC_BY_KEY[key].label });
  return settle(intake, LANDING_ACTOR);
}

/**
 * Staff tick: received / waived / rejected / missing (reset — the file is
 * deleted) / comment (a reply on the document the student sees on the
 * personal link; the status stays). An approval (אישור שקדייה) is received
 * only WITH its `validUntil` date (APPROVAL_DATE_REQUIRED); a later tick
 * with a new date renews it.
 */
async function setDocumentStatus({ intake, key, status, by, note, validUntil }) {
  const d = docOf(intake, key);
  const def = DOC_BY_KEY[key];
  const label = def.label;
  const now = new Date();
  if (status === "received") {
    if (def.approval) {
      const until = parseValidUntil(validUntil);
      if (!until) throw AppError.of("APPROVAL_DATE_REQUIRED", 400);
      d.validUntil = until;
    }
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReceived", at: now, by, note: label + (d.validUntil ? ` · בתוקף עד ${fmtDate(d.validUntil)}` : "") });
  } else if (status === "comment") {
    const text = clean(note, 300);
    d.note = text;
    intake.log.push({ action: "docNote", at: now, by, note: `${label}${text ? ` · ${text}` : " · ההערה נמחקה"}` });
  } else if (status === "waived") {
    d.status = "waived";
    d.receivedAt = now;
    d.receivedBy = by;
    d.note = clean(note, 300);
    intake.log.push({ action: "docWaived", at: now, by, note: `${label}${note ? ` · ${note}` : ""}` });
  } else if (status === "rejected") {
    d.status = "rejected";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docRejected", at: now, by, note: `${label}${note ? ` · ${note}` : ""}` });
  } else if (status === "missing") {
    const hadFile = !!d.file?.storedName;
    removeFile(intake, d);
    d.file = undefined;
    d.status = "missing";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.validUntil = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReset", at: now, by, note: label + (hadFile ? " · הקובץ נמחק" : "") });
  } else {
    throw AppError.of("INVALID_STATUS", 400, status);
  }
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
 * The meeting happened: "בוצע אינטייק". The waiver is one of the four
 * documents — ticking `waiverSigned` marks it received (signed at the
 * meeting); it no longer gates the step. What still keeps the file open
 * (the approval, documents) is written into the log.
 */
async function markDone({ intake, at, by, waiverSigned, summary }) {
  if (intake.done?.at) throw AppError.of("INTAKE_ALREADY_DONE", 400);
  const when = at ? new Date(at) : new Date();
  if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
  intake.done = { at: when, by, ...(waiverSigned && { waiverSignedAt: when }), summary: clean(summary, 4000) };
  if (waiverSigned) {
    const waiver = docOf(intake, "waiver");
    if (!docOk(waiver)) {
      waiver.status = "received";
      waiver.receivedAt = when;
      waiver.receivedBy = by;
      waiver.note = "נחתם בפגישת האינטייק";
      intake.log.push({ action: "docReceived", at: when, by, note: `${DOC_BY_KEY.waiver.label} · נחתם בפגישה` });
    }
  }
  const open = missingLabels(intake);
  intake.log.push({ action: "done", at: when, by, note: open.length ? `בוצע אינטייק · עוד חסר: ${open.join(", ")}` : "בוצע אינטייק" });
  return settle(intake, by);
}

/**
 * Recompute the record's status and keep the person's student profiles in
 * step. Called after every document / approval / meeting change.
 */
async function settle(intake, by) {
  const next = computeStatus(intake);
  intake.status = next;
  const now = new Date();
  if (next === "complete" && !intake.completedAt) {
    intake.completedAt = now;
    intake.log.push({ action: "completed", at: now, by, note: "בוצע אינטייק, אישור שקדייה וכל המסמכים התקבלו — הקליטה הושלמה" });
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
 * What the student may see through their personal link: the four documents
 * (never the office's approval) and whether the file is complete.
 */
function publicView(intake, person) {
  return {
    firstName: person?.firstName || "",
    programs: intake.landing?.programs || [],
    status: intake.status,
    complete: intake.status === "complete",
    done: !!intake.done?.at,
    scheduledAt: intake.scheduled?.at || null,
    documents: INTAKE_DOCUMENTS.filter((d) => d.upload && !d.approval).map((d) => {
      const row = (intake.documents || []).find((x) => x.key === d.key);
      return {
        key: d.key, label: d.label, hint: d.hint, optional: !!d.optional,
        status: row?.status || "missing",
        fileName: row?.file?.name || null,
        uploadedAt: row?.file?.uploadedAt || null,
        /** The staff's comment (a rejection reason or a reply) — the student reads it here. */
        note: row?.note || null,
      };
    }),
  };
}

module.exports = {
  LANDING_ACTOR,
  MAX_FILE_BYTES,
  MIME_EXT,
  uploadRoot,
  documentPath,
  missingDocs,
  missingApprovals,
  computeStatus,
  normalizePhone,
  findPerson,
  intakeOf,
  isIntakeComplete,
  ensureIntake,
  submitLanding,
  uploadDocument,
  removeStudentDocument,
  setDocumentStatus,
  schedule,
  markDone,
  settle,
  addNote,
  publicView,
  fmtHe,
};
