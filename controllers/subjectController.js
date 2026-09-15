/**
 * @file Subject controller — the managed course taxonomy
 * @module controllers/subjectController
 */

const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getSubjects = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.active === "true") filter.active = true;
  const subjects = await Subject.find(filter).sort({ name: 1 });
  res.status(200).json({ status: "success", results: subjects.length, data: { subjects } });
});

exports.createSubject = catchAsync(async (req, res) => {
  const { name, category, active } = req.body;
  const subject = await Subject.create({ name, category, active, world: req.world });
  res.status(201).json({ status: "success", data: { subject } });
});

exports.updateSubject = catchAsync(async (req, res, next) => {
  const subject = await Subject.findOne({ _id: req.params.id, world: req.world });
  if (!subject) return next(AppError.of("NOT_FOUND", 404, "מקצוע"));
  for (const k of ["name", "category", "active", "importAliases"]) {
    if (k in req.body) subject[k] = req.body[k];
  }
  await subject.save();
  res.status(200).json({ status: "success", data: { subject } });
});

/** Deletion refused while referenced — retire with active:false instead. */
exports.deleteSubject = catchAsync(async (req, res, next) => {
  const subject = await Subject.findOne({ _id: req.params.id, world: req.world });
  if (!subject) return next(AppError.of("NOT_FOUND", 404, "מקצוע"));
  const [cycles, interested, teaching] = await Promise.all([
    Cycle.countDocuments({ subject: subject._id }),
    Profile.countDocuments({ $or: [{ "matching.interests": subject._id }, { interests: subject._id }] }),
    Profile.countDocuments({ subjects: subject._id }),
  ]);
  if (cycles || interested || teaching) {
    return next(
      AppError.of("REFERENCED_BLOCKED", 409, `${cycles} מחזורים, ${interested + teaching} אנשים`)
    );
  }
  await Subject.deleteOne({ _id: subject._id });
  res.status(204).json({ status: "success", data: null });
});
