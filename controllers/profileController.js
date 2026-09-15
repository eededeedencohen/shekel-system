/**
 * @file Profile controller — the person's roles, one document per kind
 * @module controllers/profileController
 *
 * Generic by construction: kind → model comes from the registry
 * (models/profiles), and each profile schema IS its own field whitelist
 * (strict mode drops anything foreign) — adding a user type touches
 * nothing here. Guarded paths (person/world/kind/pipeline/stageHistory)
 * are stripped centrally in profileService.
 */

const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { STUDENT_KINDS } = require("../utils/domain");
const {
  createProfile,
  profilesOf,
  pickProfileFields,
  requireStudentProfile,
  flattenPerson,
} = require("../services/profileService");
const { closeProfile, reopenProfile } = require("../services/programService");

/** GET /api/people/:id/profiles?includeInactive= */
exports.getPersonProfiles = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const profiles = await profilesOf(person._id, {
    includeInactive: req.query.includeInactive === "true",
  });
  res.status(200).json({ status: "success", results: profiles.length, data: { profiles } });
});

/** POST /api/people/:id/profiles — body { kind*, ...kind fields }. */
exports.createPersonProfile = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  if (person.deletedAt) return next(AppError.of("PERSON_DELETED", 400));
  if (!req.body.kind) return next(AppError.of("MISSING_FIELDS", 400, "kind"));
  const profile = await createProfile(person, req.body.kind, req.body, {
    opened: { by: req.body.by, note: req.body.note },
    ...(STUDENT_KINDS.includes(req.body.kind) && {
      pipelineInit: { stage: req.body.stage || "Interested", movedBy: req.body.by, note: req.body.note || "נפתח פרופיל" },
    }),
  });
  res.status(201).json({ status: "success", data: { profile } });
});

/** GET /api/profiles?kind=&active= — list across people (e.g. all hostel managers). */
exports.getProfiles = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  filter.active = req.query.active === "false" ? false : true;
  if (req.query.kind) filter.kind = { $in: req.query.kind.split(",") };
  if (req.query.person) filter.person = req.query.person;
  const profiles = await Profile.find(filter)
    .populate({ path: "person", select: "firstName lastName email phone deletedAt" })
    .sort({ createdAt: 1 });
  res.status(200).json({ status: "success", results: profiles.length, data: { profiles } });
});

/** GET /api/profiles/:id */
exports.getProfileById = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world })
    .populate({ path: "person", select: "firstName lastName email phone avatar deletedAt" });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  res.status(200).json({ status: "success", data: { profile } });
});

/**
 * PATCH /api/profiles/:id — merge kind fields (schema = the whitelist).
 * `active` flips go through programService so the lifecycle log stays
 * complete (closed / reopened, with `by` + `note` when given).
 */
exports.updateProfile = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  Object.assign(profile, pickProfileFields(req.body));
  await profile.save();
  if ("active" in req.body) {
    const want = !!req.body.active;
    if (want && !profile.active) {
      await reopenProfile({ profile, world: req.world, by: req.body.by, note: req.body.note, stage: req.body.stage });
    } else if (!want && profile.active) {
      await closeProfile({ profile, world: req.world, by: req.body.by, note: req.body.note });
    }
  }
  res.status(200).json({ status: "success", data: { profile } });
});

/** DELETE /api/profiles/:id?by=&note= — close the role (logged); the person stays. */
exports.deactivateProfile = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  if (profile.active) {
    await closeProfile({ profile, world: req.world, by: req.query.by, note: req.query.note });
  }
  res.status(204).json({ status: "success", data: null });
});

/**
 * COMPAT (deprecation window): the old person-addressed endpoints —
 * POST /api/people/:id/stage and PATCH /api/people/:id/matching — resolve
 * the person's student profile, apply `fn` to it, and answer in the old
 * shape ({ person } flattened) so the current client keeps working.
 */
const asStudentProfile = (fn) =>
  catchAsync(async (req, res, next) => {
    let profile;
    try {
      profile = await requireStudentProfile(req.params.id, { kind: req.body.kind });
    } catch (e) {
      return next(AppError.of("NOT_FOUND", 404, "סטודנט"));
    }
    if (profile.world !== req.world) return next(AppError.of("NOT_FOUND", 404, "סטודנט"));
    res.set("X-Deprecated", "role-api");
    const err = await fn(profile, req);
    if (err) return next(err);
    const person = await Person.findById(profile.person);
    const profiles = await profilesOf(person._id);
    res.status(200).json({ status: "success", data: { person: flattenPerson(person, profiles) } });
  });

/** POST /api/profiles/:id/stage — body { stage*, movedBy?, note? } (students). */
exports.moveStage = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  if (typeof profile.moveToStage !== "function") {
    return next(AppError.of("NO_STUDENT_PROFILE", 404));
  }
  try {
    await profile.moveToStage(req.body.stage, req.body.movedBy, req.body.note);
  } catch (e) {
    if (e.code === "INVALID_STAGE") return next(AppError.of("INVALID_STAGE", 400));
    throw e;
  }
  res.status(200).json({ status: "success", data: { profile } });
});

/**
 * PATCH /api/profiles/:id/matching — merge the student matching profile.
 * Body: subset of { functioningLevel, groupPreference, interests };
 * null clears a key.
 */
exports.updateMatching = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  if (!profile.schema.path("matching.functioningLevel")) {
    return next(AppError.of("NO_STUDENT_PROFILE", 404));
  }
  const current = profile.matching ? profile.matching.toObject() : {};
  for (const key of ["functioningLevel", "groupPreference", "interests"]) {
    if (!(key in req.body)) continue;
    if (req.body[key] === null) delete current[key];
    else current[key] = req.body[key];
  }
  profile.matching = current;
  await profile.save();
  res.status(200).json({ status: "success", data: { profile } });
});

exports.personMoveStage = asStudentProfile(async (profile, req) => {
  try {
    await profile.moveToStage(req.body.stage, req.body.movedBy, req.body.note);
  } catch (e) {
    if (e.code === "INVALID_STAGE") return AppError.of("INVALID_STAGE", 400);
    throw e;
  }
});

exports.personUpdateMatching = asStudentProfile(async (profile, req) => {
  const current = profile.matching ? profile.matching.toObject() : {};
  for (const key of ["functioningLevel", "groupPreference", "interests"]) {
    if (!(key in req.body)) continue;
    if (req.body[key] === null) delete current[key];
    else current[key] = req.body[key];
  }
  profile.matching = current;
  await profile.save();
});
