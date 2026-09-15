/**
 * @file Profile service — the one place that knows people ↔ profiles
 * @module services/profileService
 *
 * Everything role-shaped goes through here so the rules hold from every
 * caller:
 *  - createProfile copies world from the person and enforces {person,kind}
 *    uniqueness with a proper error code.
 *  - requireStudentProfile / kindsOf are what other services use instead of
 *    the dead `person.role` field.
 *  - splitBody separates identity fields from profile fields, so the HTTP
 *    layer keeps zero per-role field lists (each profile schema IS its own
 *    whitelist — strict mode drops anything foreign).
 */

const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");
const { STUDENT_KINDS } = require("../utils/domain");
const AppError = require("../utils/AppError");

/** Identity paths — everything else in a body belongs to a profile. */
const IDENTITY_FIELDS = [
  "firstName", "lastName", "email", "phone", "birthDate", "gender",
  "senzeyId", "joinedShekelDate", "avatar", "availability",
];

/** Never mass-assignable on any profile (lifecycle goes through programService). */
const PROFILE_GUARDED = new Set([
  "person", "world", "kind", "pipeline", "stageHistory", "_id",
  "active", "since", "until", "log",
]);

/** Split a request body into { identity, profile } halves. */
function splitBody(body = {}) {
  const identity = {};
  const profile = {};
  for (const [k, v] of Object.entries(body)) {
    if (IDENTITY_FIELDS.includes(k)) identity[k] = v;
    else if (!PROFILE_GUARDED.has(k) && k !== "role" && k !== "kind" && k !== "profile") profile[k] = v;
  }
  return { identity, profile };
}

/** Strip guarded paths from a profile-fields object. */
function pickProfileFields(body = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!PROFILE_GUARDED.has(k) && k !== "kind") out[k] = v;
  }
  return out;
}

/** kind → model, or an AppError. */
function modelOfKind(kind) {
  const Model = MODEL_BY_KIND[kind];
  if (!Model) throw AppError.of("INVALID_KIND", 400, kind);
  return Model;
}

/**
 * Create a profile for an existing person. Copies world from the person,
 * translates the duplicate-key race into PROFILE_EXISTS.
 *
 * Options:
 *  - pipelineInit {stage, movedBy, note}  — student kinds start here
 *  - opened {by, note, at}                — who opened the role (log entry)
 *  - trusted                               — seeds/migration may carry a full
 *    historical pipeline AND lifecycle (since/until/active/log); the
 *    schema hooks still validate consistency.
 */
async function createProfile(person, kind, fields = {}, { pipelineInit, trusted, opened } = {}) {
  const Model = modelOfKind(kind);
  const doc = new Model({
    ...pickProfileFields(fields),
    person: person._id,
    world: person.world,
  });
  if (trusted) {
    if (STUDENT_KINDS.includes(kind)) {
      if (fields.stageHistory) doc.stageHistory = fields.stageHistory;
      if (fields.pipeline) doc.pipeline = fields.pipeline;
    }
    for (const k of ["active", "since", "until", "log"]) {
      if (fields[k] !== undefined) doc[k] = fields[k];
    }
  }
  if (pipelineInit && STUDENT_KINDS.includes(kind)) {
    const movedAt = pipelineInit.at || new Date();
    doc.stageHistory = [{ stage: pipelineInit.stage, movedBy: pipelineInit.movedBy, movedAt, note: pipelineInit.note }];
    doc.pipeline = { stage: pipelineInit.stage, since: movedAt };
  }
  if (opened) {
    doc.$locals.openedBy = opened.by;
    doc.$locals.openedNote = opened.note;
    if (opened.at && !doc.since) doc.since = opened.at;
  }
  try {
    return await doc.save();
  } catch (e) {
    if (e.code === 11000) throw AppError.of("PROFILE_EXISTS", 409, kind);
    throw e;
  }
}

/** One call for "new human with a first role" (seeds, intake, tests). */
async function createPersonWithProfile(kind, data, opts = {}) {
  const { identity, profile } = splitBody(data);
  const person = await Person.create({ ...identity, ...(data.world && { world: data.world }) });
  // Guarded paths are dropped by splitBody; trusted callers (seeds) may
  // still hand a historical pipeline + lifecycle through — createProfile
  // only applies them under `trusted`.
  const lifecycle = {};
  for (const k of ["pipeline", "stageHistory", "active", "since", "until", "log"]) {
    if (data[k] !== undefined) lifecycle[k] = data[k];
  }
  const prof = await createProfile(person, kind, { ...profile, ...lifecycle }, opts);
  return { person, profile: prof };
}

/** All profiles of a person (active by default). */
function profilesOf(personId, { includeInactive = false } = {}) {
  const filter = { person: personId };
  if (!includeInactive) filter.active = true;
  return Profile.find(filter).sort({ createdAt: 1 });
}

/** The active kinds of a person, e.g. ["ManagerHostel","StudentCulture"]. */
async function kindsOf(personId) {
  const profiles = await Profile.find({ person: personId, active: true }).select("kind");
  return profiles.map((p) => p.kind);
}

/**
 * The person's active student profile (any student kind) — or a 404-shaped
 * error. When several exist, prefers the college profile (the enrollable
 * default) unless `kind` narrows it.
 */
async function requireStudentProfile(personId, { kind } = {}) {
  const filter = { person: personId, active: true, kind: kind || { $in: STUDENT_KINDS } };
  const profiles = await Profile.find(filter);
  if (!profiles.length) throw AppError.of("NO_STUDENT_PROFILE", 404);
  return profiles.find((p) => p.kind === "StudentCollege") || profiles[0];
}

/** Active student profiles of a person — [] when none. */
function studentProfilesOf(personId) {
  return Profile.find({ person: personId, active: true, kind: { $in: STUDENT_KINDS } });
}

/**
 * Compat flattening (during the role-API deprecation window): merge the
 * "primary" profile's fields into a person JSON so the existing client
 * keeps seeing person.pipeline / person.matching / person.subjects / role.
 *
 * Program view (always on): `kinds` = active roles, `pastKinds` = closed
 * roles, `profiles` = active docs, `closedProfiles` = closed docs, and
 * `programs` = one row per student kind ever held ({kind, active, since,
 * until, stage}) — the Students list badges and the student page's
 * "תוכניות" section read these; nothing else has to know about profiles.
 */
function flattenPerson(person, profiles) {
  const p = person.toObject ? person.toObject() : { ...person };
  delete p.profiles; // replaced by the explicit array below
  const all = (profiles || []).map((x) => (x.toObject ? x.toObject() : x));
  const active = all.filter((x) => x.active !== false);
  const closed = all.filter((x) => x.active === false);
  p.kinds = active.map((x) => x.kind);
  p.pastKinds = closed.map((x) => x.kind).filter((k) => !p.kinds.includes(k));
  p.programs = all
    .filter((x) => STUDENT_KINDS.includes(x.kind))
    .map((x) => {
      const tail = Array.isArray(x.stageHistory) && x.stageHistory.length ? x.stageHistory[x.stageHistory.length - 1] : null;
      return {
        kind: x.kind,
        profile: x._id,
        active: x.active !== false,
        since: x.since || x.createdAt || null,
        until: x.until || null,
        stage: x.pipeline?.stage || null,
        /** When the current stage began + the note written at that move —
         *  per program, so a board can read either pipeline without the
         *  flattened (college-first) `pipeline` field. */
        stageSince: x.pipeline?.since || null,
        stageNote: tail?.note || null,
        stageBy: tail?.movedBy || null,
        log: x.log || [],
      };
    });
  const student = active.find((x) => x.kind === "StudentCollege") || active.find((x) => STUDENT_KINDS.includes(x.kind));
  const teacher = active.find((x) => x.kind === "Teacher");
  const culture = active.find((x) => x.kind === "StudentCulture");
  if (culture) {
    const c = culture.toObject ? culture.toObject() : culture;
    if (c.preferredCategories !== undefined) p.preferredCategories = c.preferredCategories;
  }
  if (student) {
    const s = student.toObject ? student.toObject() : student;
    p.role = "Student";
    for (const k of ["pipeline", "stageHistory", "matching", "residence", "address", "city",
      "emergencyContact", "emergencyPhone", "caseCoordinator"]) {
      if (s[k] !== undefined) p[k] = s[k];
    }
  } else if (teacher) {
    const t = teacher.toObject ? teacher.toObject() : teacher;
    p.role = "Teacher";
    if (t.subjects !== undefined) p.subjects = t.subjects;
  } else if (active.length) {
    p.role = active.some((x) => x.kind === "Admin") ? "Admin" : active[0].kind;
  }
  p.profiles = active;
  p.closedProfiles = closed;
  return p;
}

/**
 * Compat: merge student-profile fields into populated `student` objects of
 * PLAIN enrollment objects (call .toObject() first) — the client renders
 * pipeline/matching/residence on the student there.
 */
async function attachStudentData(enrollments) {
  const list = Array.isArray(enrollments) ? enrollments : [enrollments];
  const ids = [...new Set(list.map((e) => e.student?._id && String(e.student._id)).filter(Boolean))];
  if (!ids.length) return list;
  const profiles = await Profile.find({ person: { $in: ids }, active: true, kind: { $in: STUDENT_KINDS } }).lean();
  const byPerson = new Map();
  for (const pr of profiles) {
    const key = String(pr.person);
    if (!byPerson.has(key) || pr.kind === "StudentCollege") byPerson.set(key, pr);
  }
  for (const e of list) {
    if (!e.student?._id) continue;
    const pr = byPerson.get(String(e.student._id));
    if (!pr) continue;
    Object.assign(e.student, { pipeline: pr.pipeline, matching: pr.matching, residence: pr.residence });
  }
  return list;
}

module.exports = {
  IDENTITY_FIELDS,
  splitBody,
  pickProfileFields,
  modelOfKind,
  createProfile,
  createPersonWithProfile,
  profilesOf,
  kindsOf,
  requireStudentProfile,
  studentProfilesOf,
  flattenPerson,
  attachStudentData,
};
