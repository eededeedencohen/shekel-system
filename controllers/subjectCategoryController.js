/**
 * @file Subject-category controller - the catalogue's named categories
 * @module controllers/subjectCategoryController
 * @see services/subjectCategoryService
 */

const svc = require("../services/subjectCategoryService");
const catchAsync = require("../utils/catchAsync");

/** GET /api/subject-categories - the named rows alone (the merged list is in /api/meta/domain). */
exports.list = catchAsync(async (req, res) => {
  const rows = await svc.customRows();
  const subjectCategories = rows.map((r) => ({ ...r, key: String(r._id) }));
  res.status(200).json({ status: "success", results: subjectCategories.length, data: { subjectCategories } });
});

/** POST /api/subject-categories { label } */
exports.create = catchAsync(async (req, res) => {
  const row = await svc.createCategory({ label: req.body.label, by: req.actor?.label || req.body.by });
  res.status(201).json({ status: "success", data: { subjectCategory: row } });
});

/** PUT /api/subject-categories/:id { label?, active? } */
exports.update = catchAsync(async (req, res) => {
  const row = await svc.updateCategory(req.params.id, { label: req.body.label, active: req.body.active });
  res.status(200).json({ status: "success", data: { subjectCategory: row } });
});

/** DELETE /api/subject-categories/:id - refused while a subject points here */
exports.remove = catchAsync(async (req, res) => {
  await svc.deleteCategory(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
