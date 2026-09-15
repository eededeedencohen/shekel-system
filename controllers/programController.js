/**
 * @file Program controller — a student's memberships in the two programs
 * @module controllers/programController
 * @see services/programService
 *
 *   POST /api/people/:id/transfer      { from*, to*, by?, note?, stage? }
 *   GET  /api/people/:id/programs      the merged program timeline
 *   POST /api/profiles/:id/close       { by?, note? }
 *   POST /api/profiles/:id/reopen      { by?, note?, stage? }
 */

const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { transfer, closeProfile, reopenProfile, programTimeline } = require("../services/programService");
const { profilesOf, flattenPerson } = require("../services/profileService");

async function respondWithPerson(res, personId, extra = {}) {
  const person = await Person.findById(personId);
  const profiles = await profilesOf(person._id, { includeInactive: true });
  res.status(200).json({ status: "success", data: { person: flattenPerson(person, profiles), ...extra } });
}

exports.transferProgram = catchAsync(async (req, res, next) => {
  const { from, to, by, note, stage, at } = req.body;
  if (!from || !to) return next(AppError.of("MISSING_FIELDS", 400, "from, to"));
  const { effects } = await transfer({ personId: req.params.id, world: req.world, from, to, by, note, stage, at });
  await respondWithPerson(res, req.params.id, { effects });
});

exports.getProgramTimeline = catchAsync(async (req, res, next) => {
  const person = await Person.findOne({ _id: req.params.id, world: req.world });
  if (!person) return next(AppError.of("NOT_FOUND", 404, "אדם"));
  const timeline = await programTimeline(person._id);
  res.status(200).json({ status: "success", data: timeline });
});

exports.closeProfile = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  const { effects } = await closeProfile({ profile, world: req.world, by: req.body.by, note: req.body.note, at: req.body.at });
  await respondWithPerson(res, profile.person, { effects });
});

exports.reopenProfile = catchAsync(async (req, res, next) => {
  const profile = await Profile.findOne({ _id: req.params.id, world: req.world });
  if (!profile) return next(AppError.of("NOT_FOUND", 404, "פרופיל"));
  await reopenProfile({ profile, world: req.world, by: req.body.by, note: req.body.note, stage: req.body.stage, at: req.body.at });
  await respondWithPerson(res, profile.person);
});
