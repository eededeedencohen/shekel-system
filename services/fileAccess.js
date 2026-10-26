/**
 * @file fileAccess - may this persona read or change this file?
 * @module services/fileAccess
 *
 * One answer for every family, derived from what already decides access
 * in the app rather than a second list that could drift from it: the
 * family gate (utils/auth FAMILIES) and the lens (services/lensService -
 * the persona's own people). A file's `family` + `owner` say where to
 * look; `allowedAccounts` adds an explicit grant on top. The super admin
 * sees all; viewing as someone is that someone (req.actor).
 *
 *   people     the person is in the lens
 *   intake     the intake's person is in the lens (waiver too)
 *   suppliers  the suppliers family (the hostels coordinator, super)
 *   invoices   the invoices family and the teacher in the lens
 *   culture    the culture family
 *   library    the library family (super)
 *
 * The public pages are not here: their authority is the link's token, and
 * fileService's family rules judge it (`actor.token`).
 */

const Intake = require("../models/Intake");
const Invoice = require("../models/Invoice");
const AppError = require("../utils/AppError");
const { FAMILIES } = require("../utils/auth");
const lens = require("./lensService");

const inFamily = (name, kind) => (FAMILIES[name] || []).includes(kind);

async function personInLens(req, personId) {
  if (!personId) return false;
  const ids = await lens.scopeOf(req).people();
  return !ids || ids.has(String(personId));
}

/** true / false - read and write are the same question today (whoever may see a file may replace it on its record). */
async function can(req, file) {
  const actor = req.actor;
  if (!actor || !file) return false;
  const { lens: l } = lens.scopeOf(req);
  if (l.all) return true;
  if (req.account?._id && (file.allowedAccounts || []).some((a) => String(a) === String(req.account._id))) return true;
  const owner = file.owner || {};
  switch (file.family) {
    case "people":
      return personInLens(req, owner.id);
    case "intake":
    case "waiver": {
      const intake = owner.id && (await Intake.findById(owner.id).select("person").lean());
      return intake ? personInLens(req, intake.person) : false;
    }
    case "suppliers":
      return inFamily("suppliers", actor.kind);
    case "invoices": {
      if (!inFamily("invoices", actor.kind)) return false;
      if (owner.kind === "person") return personInLens(req, owner.id);
      const invoice = owner.id && (await Invoice.findById(owner.id).select("teacher").lean());
      return invoice ? personInLens(req, invoice.teacher) : false;
    }
    case "culture":
      return inFamily("culture", actor.kind);
    case "library":
      return inFamily("library", actor.kind);
    default:
      return false;
  }
}

/** 403 OUT_OF_SCOPE unless `can`. */
async function assert(req, file) {
  if (!(await can(req, file))) throw AppError.of("OUT_OF_SCOPE", 403);
}

module.exports = { can, assert, personInLens, inFamily };
