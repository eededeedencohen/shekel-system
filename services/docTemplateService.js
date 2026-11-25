/**
 * @file docTemplateService - the staff's written templates (models/DocTemplate)
 * @module services/docTemplateService
 *
 * Rules (Eden, 2026-11-19; who sees and who manages: 2026-11-25 - "אני
 * יכול לראות הכול ולנהל מי יוכל לראות את התבניות. רק אני ויוצר התבנית
 * יכולים לערוך… אחרים שיש להם הרשאות צפייה יכולים להשתמש בתבנית ולהעתיק
 * אותה. ההעתק יהיה שייך אליהם. יוצר התבנית יוכל להגדיר מי מהעובדים יוכל
 * להשתמש בתבנית"):
 *  - a template is SEEN by its maker, by the super admin, and by whoever
 *    its audience names: everyone on the staff ("all" - how every template
 *    was before), or the chosen accounts alone ("some"; none chosen = the
 *    maker alone). Whoever sees it writes from it and may copy it;
 *  - it is changed, deleted and shared by the account that made it and by
 *    the super admin (TEMPLATE_NOT_YOURS for anyone else who sees it; a
 *    template one does not see does not exist - 404);
 *  - a copy is a new template of the copier's, remembering its source; a
 *    copy of a template that not everyone sees starts as the copier's alone;
 *  - the document is kept checked (utils/richDoc) with its plain text.
 * "The super admin" is the ACTING one: viewing as someone, he is that someone.
 */

const mongoose = require("mongoose");
const DocTemplate = require("../models/DocTemplate");
const StaffAccount = require("../models/StaffAccount");
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

const isSuper = (actor) => actor?.kind === "super";
const openToAll = (row) => row.audience !== "some";

/** Does this account see the template? */
function sees(row, actor) {
  const me = ownerOf(actor).owner;
  return isSuper(actor) || row.owner === me || openToAll(row) || (row.viewers || []).includes(me);
}

/** The templates the acting account sees, the latest change first (the super admin: every one). */
function list(actor) {
  const me = ownerOf(actor).owner;
  const filter = isSuper(actor) ? {} : { $or: [{ owner: me }, { audience: { $ne: "some" } }, { viewers: me }] };
  return DocTemplate.find(filter).sort({ updatedAt: -1 });
}

/**
 * Who sees a template, as it is kept: "all", or "some" with the accounts named (never the maker - the maker
 * always sees; an id that is no staff account is dropped). `undefined` = not said.
 */
async function audienceOf({ audience, viewers }, owner) {
  if (audience === undefined && viewers === undefined) return null;
  if (audience !== "all" && audience !== "some") throw AppError.of("TEMPLATE_AUDIENCE_INVALID", 400);
  if (audience === "all") return { audience: "all", viewers: [] };
  if (viewers !== undefined && !Array.isArray(viewers)) throw AppError.of("TEMPLATE_AUDIENCE_INVALID", 400);
  let ids = [...new Set((viewers || []).map((v) => String(v)).filter((v) => /^[\w.-]{1,64}$/.test(v) && v !== owner))].slice(0, 300);
  const real = ids.filter((v) => mongoose.isValidObjectId(v));
  if (real.length) {
    const staff = new Set((await StaffAccount.find({ _id: { $in: real }, kind: { $ne: "teacher" } }).select("_id").lean()).map((a) => String(a._id)));
    ids = ids.filter((v) => !mongoose.isValidObjectId(v) || staff.has(v));
  }
  return { audience: "some", viewers: ids };
}

async function create({ name, kind, doc, copiedFrom, audience, viewers, actor }) {
  const { owner, ownerName } = ownerOf(actor);
  if (!owner) throw AppError.of("AUTH_FORBIDDEN", 403);
  const clean = doc === undefined || doc === null ? emptyDoc() : cleanDoc(doc);
  const row = { name: cleanName(name) || UNNAMED, kind: kindOf(kind), doc: clean, text: textOf(clean), owner, ownerName };
  let copyOfShut = false;
  if (copiedFrom && mongoose.isValidObjectId(copiedFrom)) {
    // where a copy came from is read here, never taken from the request - and only a template the copier sees
    const src = await DocTemplate.findById(copiedFrom).select("name owner ownerName audience viewers");
    if (src && sees(src, actor)) {
      row.copiedFrom = { template: src._id, name: src.name, ownerName: src.ownerName };
      copyOfShut = !openToAll(src);
    }
  }
  // who sees it: what was said; unsaid - everyone, but a copy of a template not everyone sees is the copier's alone
  Object.assign(row, (await audienceOf({ audience, viewers }, owner)) || (copyOfShut ? { audience: "some", viewers: [] } : { audience: "all", viewers: [] }));
  return DocTemplate.create(row);
}

/** The template, for whoever may change it: the one who made it, and the super admin. */
async function own(id, actor) {
  const row = mongoose.isValidObjectId(id) ? await DocTemplate.findById(id) : null;
  if (!row || !sees(row, actor)) throw AppError.of("NOT_FOUND", 404, "תבנית");
  if (row.owner !== ownerOf(actor).owner && !isSuper(actor)) throw AppError.of("TEMPLATE_NOT_YOURS", 403);
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
  // the name on it follows its maker's account name (the super admin changing someone's template leaves it theirs)
  if (row.owner === ownerOf(actor).owner) row.ownerName = ownerOf(actor).ownerName || row.ownerName;
  await row.save();
  return row;
}

/** Who sees the template - said by its maker or by the super admin. */
async function setAudience({ id, audience, viewers, actor }) {
  const row = await own(id, actor);
  const next = await audienceOf({ audience, viewers }, row.owner);
  if (!next) throw AppError.of("TEMPLATE_AUDIENCE_INVALID", 400);
  // (straight to the table: the document's own "last changed" does not move when only its readers do)
  await DocTemplate.updateOne({ _id: row._id }, { $set: next }, { timestamps: false });
  Object.assign(row, next);
  return row;
}

async function remove({ id, actor }) {
  const row = await own(id, actor);
  await row.deleteOne();
  return row;
}

module.exports = { list, create, update, remove, setAudience, sees, ownerOf, UNNAMED };
