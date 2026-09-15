/**
 * @file Intake service — the social worker's flow (קליטה / אינטייק) and the
 *       public sign-up page behind it
 * @module services/intakeService
 *
 * Eden's state diagram (2026-09-09), in code:
 *
 *   landing page ─┬─ תרבות לכל: profile at Interested ──────────────────┐
 *                 └─ מכללה לכל: profile at Interested → managers find a │
 *                    seat (enrollmentService → ReservedSeat) ───────────┤
 *                                                                       ▼
 *   schedule()  — ייטב calls, sets a date   → profiles → Intake
 *   markDone()  — meeting held + waiver     → all docs in? Placed*
 *                                             else        AwaitingDocuments
 *   documents   — uploads / staff ticks     → last doc in → Placed*
 *
 *   * a מכללה profile with a reserved seat gets it activated and lands on
 *     Placed; without a seat it waits at AwaitingPlacement for the managers.
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
  DOCUMENT_OK_STATUSES,
  INTAKE_STAGES,
  PRE_INTAKE_STAGES,
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
const requiredDocs = () => INTAKE_DOCUMENTS.filter((d) => !d.optional);
const docOk = (d) => DOCUMENT_OK_STATUSES.includes(d?.status);

/** Keys of the REQUIRED documents that are not in yet. */
function missingDocs(intake) {
  return requiredDocs()
    .filter((d) => !docOk((intake.documents || []).find((x) => x.key === d.key)))
    .map((d) => d.key);
}
const missingLabels = (intake) => missingDocs(intake).map((k) => DOC_BY_KEY[k].label);

/** The record's state from its facts (the ONE definition). */
function computeStatus(intake) {
  if (intake.done?.at) return missingDocs(intake).length ? "documents" : "complete";
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

/**
 * Store a file for a document key. `data` = Buffer or base64 (data-URI
 * tolerated). A student upload (staff=false) can replace its own earlier
 * upload but never a document the staff already confirmed.
 */
async function uploadDocument({ intake, key, fileName, mime, data, by, staff = false }) {
  const def = DOC_BY_KEY[key];
  if (!def) throw AppError.of("DOCUMENT_UNKNOWN", 400, key);
  if (!def.upload && !staff) throw AppError.of("DOCUMENT_UNKNOWN", 400, def.label);
  const ext = MIME_EXT[String(mime || "").toLowerCase()];
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!ext || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("DOCUMENT_INVALID", 400);

  const d = docOf(intake, key);
  if (!staff && d.status === "received") throw AppError.of("DOCUMENT_LOCKED", 400);

  fs.mkdirSync(fileDir(intake), { recursive: true });
  removeFile(intake, d);
  const storedName = `${key}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(fileDir(intake), storedName), buffer);
  const now = new Date();
  d.file = { name: clean(fileName, 120) || `${key}.${ext}`, storedName, mime: mime.toLowerCase(), size: buffer.length, uploadedAt: now, by: staff ? by : "student" };
  d.note = undefined;
  if (staff) {
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
  } else {
    d.status = "uploaded";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
  }
  intake.log.push({ action: "docUploaded", at: now, by: staff ? by : LANDING_ACTOR, note: def.label });
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

/** Staff tick: received / waived / rejected / missing (reset). */
async function setDocumentStatus({ intake, key, status, by, note }) {
  const d = docOf(intake, key);
  const label = DOC_BY_KEY[key].label;
  const now = new Date();
  if (status === "received") {
    d.status = "received";
    d.receivedAt = now;
    d.receivedBy = by;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReceived", at: now, by, note: label });
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
    removeFile(intake, d);
    d.file = undefined;
    d.status = "missing";
    d.receivedAt = undefined;
    d.receivedBy = undefined;
    d.note = clean(note, 300);
    intake.log.push({ action: "docReset", at: now, by, note: label });
  } else {
    throw AppError.of("INVALID_STATUS", 400, status);
  }
  return settle(intake, by);
}

/* ───────────────────────── the social worker's steps ───────────────────────── */

/** Set (or move) the intake meeting; pre-intake profiles step to Intake. */
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
  for (const p of await studentProfilesOf(intake.person)) {
    if (PRE_INTAKE_STAGES.includes(p.pipeline?.stage)) {
      await p.moveToStage("Intake", by, `נקבע אינטייק ל${fmtHe(when)}${note ? ` · ${clean(note, 200)}` : ""}`);
      moved.push(p.kind);
    }
  }
  return { intake, moved };
}

/** The meeting happened and the waiver was signed. */
async function markDone({ intake, at, by, waiverSigned, summary }) {
  if (intake.done?.at) throw AppError.of("INTAKE_ALREADY_DONE", 400);
  if (!waiverSigned) throw AppError.of("WAIVER_REQUIRED", 400);
  const when = at ? new Date(at) : new Date();
  if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
  intake.done = { at: when, by, waiverSignedAt: when, summary: clean(summary, 4000) };
  const waiver = docOf(intake, "waiver");
  waiver.status = "received";
  waiver.receivedAt = when;
  waiver.receivedBy = by;
  intake.log.push({ action: "done", at: when, by, note: "בוצע אינטייק + נחתם ויתור סודיות" });
  return settle(intake, by);
}

/**
 * Recompute the record's status and keep the person's student profiles in
 * step. Called after every document/meeting change.
 */
async function settle(intake, by) {
  const next = computeStatus(intake);
  intake.status = next;
  const now = new Date();
  if (next === "complete" && !intake.completedAt) {
    intake.completedAt = now;
    intake.log.push({ action: "completed", at: now, by, note: "כל המסמכים התקבלו — הקליטה הושלמה" });
  }
  await intake.save();

  const moved = [];
  const profiles = await studentProfilesOf(intake.person);
  if (next === "complete") {
    for (const p of profiles) {
      const stage = p.pipeline?.stage;
      if (p.kind === "StudentCulture") {
        if ([...PRE_INTAKE_STAGES, ...INTAKE_STAGES].includes(stage)) {
          await p.moveToStage("Placed", by, "הקליטה הושלמה");
          moved.push({ kind: p.kind, stage: "Placed" });
        }
        continue;
      }
      // מכללה לכל: a held seat becomes the real one; otherwise the managers place them.
      if (![...INTAKE_STAGES, "ReservedSeat"].includes(stage)) continue;
      const live = await Enrollment.find({ student: intake.person, status: { $in: OCCUPYING_STATUSES } });
      if (live.length) {
        for (const e of live) {
          if (e.status !== "reserved") continue;
          e.status = "active";
          e.joinedAt = now;
          e.note = [e.note, "הופעל בסיום הקליטה"].filter(Boolean).join(" · ");
          await e.save();
        }
        await p.moveToStage("Placed", by, "הקליטה הושלמה — השיבוץ הופעל");
        moved.push({ kind: p.kind, stage: "Placed" });
      } else {
        await p.moveToStage("AwaitingPlacement", by, "הקליטה הושלמה — ממתין/ה לשיבוץ");
        moved.push({ kind: p.kind, stage: "AwaitingPlacement" });
      }
    }
  } else if (next === "documents") {
    const labels = missingLabels(intake).join(", ");
    for (const p of profiles) {
      if ([...PRE_INTAKE_STAGES, "Intake"].includes(p.pipeline?.stage)) {
        await p.moveToStage("AwaitingDocuments", by, `בוצע אינטייק · חסרים: ${labels}`);
        moved.push({ kind: p.kind, stage: "AwaitingDocuments" });
      }
    }
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

/** What the student may see through their personal link. */
function publicView(intake, person) {
  return {
    firstName: person?.firstName || "",
    programs: intake.landing?.programs || [],
    status: intake.status,
    complete: intake.status === "complete",
    done: !!intake.done?.at,
    scheduledAt: intake.scheduled?.at || null,
    documents: INTAKE_DOCUMENTS.filter((d) => d.upload).map((d) => {
      const row = (intake.documents || []).find((x) => x.key === d.key);
      return {
        key: d.key, label: d.label, hint: d.hint, optional: !!d.optional,
        status: row?.status || "missing",
        fileName: row?.file?.name || null,
        uploadedAt: row?.file?.uploadedAt || null,
        note: row?.status === "rejected" ? row.note || null : null,
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
