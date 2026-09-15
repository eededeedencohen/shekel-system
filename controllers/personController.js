/**
 * @file Person controller — identity CRUD (the profiles live elsewhere)
 * @module controllers/personController
 *
 * `:id` is the ONE person id (people._id). After the identity+profiles
 * split this controller only touches identity fields; everything
 * role-shaped goes through profileController. A thin COMPAT layer keeps
 * the current client working during the deprecation window:
 *  - `?role=Student` maps to the student kinds, `?stage=` filters via
 *    student profiles;
 *  - responses are flattened (person.pipeline / person.matching /
 *    person.subjects / person.role come from the primary profile) and
 *    carry `X-Deprecated: role-api` when the legacy shape was requested;
 *  - POST with `{ role, ...flat }` still works — it builds a profile.
 * Remove the compat paths at the end of phase 4 (people-remodel-plan.html).
 */

const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Enrollment = require("../models/Enrollment");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { STUDENT_KINDS } = require("../utils/domain");
const {
  IDENTITY_FIELDS,
  splitBody,
  createProfile,
  profilesOf,
  flattenPerson,
} = require("../services/profileService");

/** role query/body value → profile kinds (compat). */
const KINDS_BY_ROLE = {
  Student: STUDENT_KINDS,
  Teacher: ["Teacher"],
  Admin: ["Admin"],
};

function pickIdentity(body) {
  const out = {};
  for (const k of IDENTITY_FIELDS) if (k in body) out[k] = body[k];
  return out;
}

/**
 * Batch-load profiles for a list of people: personId → [profiles]. ALL of
 * them, active and closed — flattenPerson splits the two, and the closed
 * ones are what makes "עבר/ה מתוכנית" visible in lists.
 */
async function profilesByPerson(people) {
  const ids = people.map((p) => p._id);
  const profiles = await Profile.find({ person: { $in: ids } });
  const map = new Map();
  for (const pr of profiles) {
    const key = String(pr.person);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(pr);
  }
  return map;
}

/** GET /api/people?kind=&role=&stage=&includeDeleted= */
exports.getPeople = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.includeDeleted !== "true") filter.deletedAt = null;

  // kind/role/stage all narrow through the profiles collection.
  let kinds = null;
  if (req.query.kind) kinds = req.query.kind.split(",");
  else if (req.query.role) {
    kinds = KINDS_BY_ROLE[req.query.role] || [];
    res.set("X-Deprecated", "role-api");
  }
  if (kinds || req.query.stage) {
    const pf = { world: req.world, active: true };
    if (kinds) pf.kind = { $in: kinds };
    if (req.query.stage) {
      pf["pipeline.stage"] = { $in: req.query.stage.split(",") };
      if (!kinds) pf.kind = { $in: STUDENT_KINDS };
    }
    filter._id = { $in: await Profile.distinct("person", pf) };
  }

  const people = await Person.find(filter).sort({ firstName: 1, lastName: 1 });
  const map = await profilesByPerson(people);
  const flat = people.map((p) => flattenPerson(p, map.get(String(p._id)) || []));
  res.status(200).json({ status: "success", results: flat.length, data: { people: flat } });
});

/** GET /api/people/:id — identity + all its profiles (flattened compat). */
exports.getPersonById = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const profiles = await profilesOf(person._id, { includeInactive: true }).populate([
    { path: "matching.interests", select: "name category" },
    { path: "interests", select: "name category" },
    { path: "subjects", select: "name category" },
    { path: "residence.hostel", select: "name" },
    { path: "hostels", select: "name" },
  ]);
  res.status(200).json({ status: "success", data: { person: flattenPerson(person, profiles) } });
});

/**
 * POST /api/people — identity, plus optionally a first profile:
 *   { firstName*, ..., profile?: { kind, ...fields } }
 * COMPAT: { role, ...flat } builds the matching profile from the flat body.
 */
exports.createPerson = catchAsync(async (req, res, next) => {
  const person = await Person.create({ ...pickIdentity(req.body), world: req.world });

  let profile = null;
  if (req.body.profile?.kind) {
    profile = await createProfile(person, req.body.profile.kind, req.body.profile);
  } else if (req.body.role) {
    const kinds = KINDS_BY_ROLE[req.body.role];
    if (!kinds) return next(AppError.of("INVALID_KIND", 400, req.body.role));
    res.set("X-Deprecated", "role-api");
    profile = await createProfile(person, kinds[0], splitBody(req.body).profile);
  }
  res.status(201).json({
    status: "success",
    data: { person: flattenPerson(person, profile ? [profile] : []) },
  });
});

/**
 * PUT /api/people/:id — identity merge (never world/auth/deletedAt).
 * COMPAT: leftover flat profile fields are routed to the person's primary
 * profile when exactly one active profile exists.
 */
exports.updatePerson = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const { identity, profile: leftovers } = splitBody(req.body);
  Object.assign(person, identity);
  await person.save();

  let profiles = await profilesOf(person._id);
  if (Object.keys(leftovers).length && profiles.length === 1) {
    res.set("X-Deprecated", "role-api");
    Object.assign(profiles[0], leftovers);
    await profiles[0].save();
  }
  res.status(200).json({ status: "success", data: { person: flattenPerson(person, profiles) } });
});

/** DELETE /api/people/:id — soft delete, always (profiles stay, inert). */
exports.deletePerson = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  person.deletedAt = new Date();
  await person.save();
  res.status(204).json({ status: "success", data: null });
});

/**
 * PATCH /api/people/:id/availability — replace the weekly availability.
 * (Teacher subjects moved to PATCH /api/profiles/:id — compat keeps
 * accepting them here while exactly one Teacher profile exists.)
 */
exports.updateAvailability = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  if (Array.isArray(req.body.availability)) person.availability = req.body.availability;
  await person.save();

  const profiles = await profilesOf(person._id);
  if (Array.isArray(req.body.subjects)) {
    const teacher = profiles.find((p) => p.kind === "Teacher");
    if (teacher) {
      res.set("X-Deprecated", "role-api");
      teacher.subjects = req.body.subjects;
      await teacher.save();
    }
  }
  res.status(200).json({ status: "success", data: { person: flattenPerson(person, profiles) } });
});

/** GET /api/people/:id/enrollments — the person's memberships (as student). */
exports.getPersonEnrollments = catchAsync(async (req, res) => {
  const enrollments = await Enrollment.find({ student: req.params.id, world: req.world })
    .populate({
      path: "cycle",
      select: "subject teacher status startDate endDate schedule hostel venue matching.capacity",
      populate: [
        { path: "subject", select: "name category" },
        { path: "teacher", select: "firstName lastName" },
      ],
    })
    .sort({ createdAt: -1 });
  res.status(200).json({ status: "success", results: enrollments.length, data: { enrollments } });
});
