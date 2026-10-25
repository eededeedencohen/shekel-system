/**
 * @file Subject-category service - the catalogue's categories as ONE list
 * @module services/subjectCategoryService
 *
 * Built-in keys (utils/domain SUBJECT_CATEGORIES) + the rows the staff named
 * (models/SubjectCategory). A Subject's `category` is valid when it is
 * either; the meta payload and the public sign-up options serve the merged
 * list so every reader resolves a label the same way.
 */

const mongoose = require("mongoose");
const SubjectCategory = require("../models/SubjectCategory");
const Subject = require("../models/Subject");
const AppError = require("../utils/AppError");
const { SUBJECT_CATEGORIES, SUBJECT_CATEGORY_KEYS } = require("../utils/domain");

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
const fold = (s) => norm(s).toLowerCase();
const isId = (v) => mongoose.isValidObjectId(v);

const toEntry = (row) => ({ key: String(row._id), label: row.label, custom: true, active: row.active !== false });

/** The custom rows, by label. */
const customRows = () => SubjectCategory.find().sort({ label: 1 }).lean();

/** Built-ins first (in their order), then the named ones - what /api/meta serves. */
async function allCategories() {
  const rows = await customRows();
  return [...SUBJECT_CATEGORIES, ...rows.map(toEntry)];
}

/** Is this key a category - built-in or a named row? Throws 400 SUBJECT_CATEGORY_UNKNOWN when not. */
async function assertCategoryKey(key) {
  if (key == null || key === "") return;
  if (SUBJECT_CATEGORY_KEYS.includes(key)) return;
  if (isId(key) && (await SubjectCategory.exists({ _id: key }))) return;
  throw AppError.of("SUBJECT_CATEGORY_UNKNOWN", 400, String(key));
}

/** A label already in use - a built-in's or a row's (case and spacing folded). */
async function findByLabel(label) {
  const f = fold(label);
  const builtIn = SUBJECT_CATEGORIES.find((c) => fold(c.label) === f);
  if (builtIn) return builtIn;
  const rows = await customRows();
  const row = rows.find((r) => fold(r.label) === f);
  return row ? toEntry(row) : null;
}

/** A new named category; the same name twice is refused (409 SUBJECT_CATEGORY_EXISTS). */
async function createCategory({ label, by }) {
  const clean = norm(label);
  if (!clean) throw AppError.of("MISSING_FIELDS", 400, "label");
  const taken = await findByLabel(clean);
  if (taken) throw AppError.of("SUBJECT_CATEGORY_EXISTS", 409, taken.label);
  const row = await SubjectCategory.create({ label: clean, createdBy: by || undefined });
  return row;
}

async function updateCategory(id, { label, active }) {
  const row = await SubjectCategory.findById(id);
  if (!row) throw AppError.of("NOT_FOUND", 404, "קטגוריה");
  if (label !== undefined) {
    const clean = norm(label);
    if (!clean) throw AppError.of("MISSING_FIELDS", 400, "label");
    const taken = await findByLabel(clean);
    if (taken && taken.key !== String(row._id)) throw AppError.of("SUBJECT_CATEGORY_EXISTS", 409, taken.label);
    row.label = clean;
  }
  if (active !== undefined) row.active = !!active;
  await row.save();
  return row;
}

/** Deletion refused while a subject points here (409 REFERENCED_BLOCKED). */
async function deleteCategory(id) {
  const row = await SubjectCategory.findById(id);
  if (!row) throw AppError.of("NOT_FOUND", 404, "קטגוריה");
  const used = await Subject.countDocuments({ category: String(row._id) });
  if (used) throw AppError.of("REFERENCED_BLOCKED", 409, `${used} קורסים`);
  await SubjectCategory.deleteOne({ _id: row._id });
}

module.exports = { allCategories, assertCategoryKey, findByLabel, createCategory, updateCategory, deleteCategory, customRows };
