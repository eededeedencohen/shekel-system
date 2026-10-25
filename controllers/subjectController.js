/**
 * @file Subject controller - the managed course taxonomy
 * @module controllers/subjectController
 */

const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { assertCategoryKey } = require("../services/subjectCategoryService");

exports.getSubjects = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.active === "true") filter.active = true;
  const subjects = await Subject.find(filter).sort({ name: 1 });
  res.status(200).json({ status: "success", results: subjects.length, data: { subjects } });
});

/** POST /api/subjects { name, category?, active? } - the category is a built-in key or a named category's id. */
exports.createSubject = catchAsync(async (req, res) => {
  const { name, category, active } = req.body;
  await assertCategoryKey(category);
  const subject = await Subject.create({ name, category: category || undefined, active });
  res.status(201).json({ status: "success", data: { subject } });
});

exports.updateSubject = catchAsync(async (req, res, next) => {
  const subject = await Subject.findById(req.params.id);
  if (!subject) return next(AppError.of("NOT_FOUND", 404, "מקצוע"));
  if ("category" in req.body) await assertCategoryKey(req.body.category);
  for (const k of ["name", "category", "active", "importAliases"]) {
    if (k in req.body) subject[k] = req.body[k];
  }
  await subject.save();
  res.status(200).json({ status: "success", data: { subject } });
});

/** Deletion refused while referenced - retire with active:false instead. */
exports.deleteSubject = catchAsync(async (req, res, next) => {
  const subject = await Subject.findById(req.params.id);
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
