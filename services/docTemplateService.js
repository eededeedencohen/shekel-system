/**
 * @file docTemplateService - the staff's written templates (models/DocTemplate)
 * @module services/docTemplateService
 *
 * Rules (Eden, 2026-11-19):
 *  - everyone on the staff reads every template and may write from it;
 *  - a template is changed and deleted by the account that made it, alone
 *    (TEMPLATE_NOT_YOURS for anyone else - the super admin included: to
 *    change someone's template you copy it into one of your own);
 *  - a copy is a new template of the copier's, remembering its source;
 *  - the document is kept checked (utils/richDoc) with its plain text.
 */

const mongoose = require("mongoose");
const DocTemplate = require("../models/DocTemplate");
const AppError = require("../utils/AppError");
const { DOC_TEMPLATE_KINDS } = require("../utils/domain");
const { cleanDoc, textOf, emptyDoc } = require("../utils/richDoc");

const UNNAMED = "תבנית בלי שם";
const cleanName = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 120);
const kindOf = (v) => (DOC_TEMPLATE_KINDS.includes(v) ? v : null);

/** Who acts, as the templates know them: the acting account's id (the tests' bypass account has none - its username). */
function ownerOf(actor) {
  return { owner: String(actor?._id || actor?.username || ""), ownerName: actor?.name || "" };
}

/** Every template, the latest change first. */
function list() {
  return DocTemplate.find().sort({ updatedAt: -1 });
}

async function create({ name, kind, doc, copiedFrom, actor }) {
  const { owner, ownerName } = ownerOf(actor);
  if (!owner) throw AppError.of("AUTH_FORBIDDEN", 403);
  const clean = doc === undefined || doc === null ? emptyDoc() : cleanDoc(doc);
  const row = { name: cleanName(name) || UNNAMED, kind: kindOf(kind), doc: clean, text: textOf(clean), owner, ownerName };
  if (copiedFrom && mongoose.isValidObjectId(copiedFrom)) {
    // where a copy came from is read here, never taken from the request
    const src = await DocTemplate.findById(copiedFrom).select("name ownerName");
    if (src) row.copiedFrom = { template: src._id, name: src.name, ownerName: src.ownerName };
  }
  return DocTemplate.create(row);
}

/** The template, for the one who made it - anyone else is refused. */
async function own(id, actor) {
  const row = mongoose.isValidObjectId(id) ? await DocTemplate.findById(id) : null;
  if (!row) throw AppError.of("NOT_FOUND", 404, "תבנית");
  if (row.owner !== ownerOf(actor).owner) throw AppError.of("TEMPLATE_NOT_YOURS", 403);
  return row;
}

async function update({ id, name, kind, doc, actor }) {
  const row = await own(id, actor);
  if (name !== undefined) row.name = cleanName(name) || UNNAMED;
  if (kind !== undefined) row.kind = kindOf(kind);
  if (doc !== undefined) {
    row.doc = cleanDoc(doc);
    row.text = textOf(row.doc);
    row.markModified("doc");
  }
  // the name on it follows the account's name
  row.ownerName = ownerOf(actor).ownerName || row.ownerName;
  await row.save();
  return row;
}

async function remove({ id, actor }) {
  const row = await own(id, actor);
  await row.deleteOne();
  return row;
}

module.exports = { list, create, update, remove, ownerOf, UNNAMED };
