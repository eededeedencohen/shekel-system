/**
 * @file Supplier controller - the coordinator's API and the supplier's public one
 * @module controllers/supplierController
 *
 * /api/suppliers (signed in; the hostels coordinator and the super admin -
 * Eden, 2026-10-14: "לתת אותו כרגע רק לשמרית") and /api/public/supplier/:token
 * (the supplier, no login - the token is the only key). All the rules live
 * in services/supplierService.
 */

const Supplier = require("../models/Supplier");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { notModified } = require("../utils/sendFile");
const suppliers = require("../services/supplierService");

const by = (req) => req.actor?.name || req.account?.name || "";

/** The suppliers page is the hostels coordinator's (and the super admin's). */
exports.requireSupplierStaff = (req, res, next) => {
  const kind = req.actor?.kind;
  if (kind === "hostels" || kind === "super") return next();
  return next(AppError.of("NOT_SUPPLIER_STAFF", 403));
};

async function load(req) {
  const s = await Supplier.findOne({ _id: req.params.id, world: req.world });
  if (!s) throw AppError.of("NOT_FOUND", 404, "ספק");
  return s;
}

const answer = (res, s, status = 200) => res.status(status).json({ status: "success", data: { supplier: suppliers.staffView(s) } });

/* ───────────────────────── staff ───────────────────────── */

exports.list = catchAsync(async (req, res) => {
  const rows = await Supplier.find({ world: req.world }).sort({ updatedAt: -1 });
  res.status(200).json({ status: "success", results: rows.length, data: { suppliers: rows.map(suppliers.staffView) } });
});

exports.create = catchAsync(async (req, res) => {
  const s = await suppliers.create({ world: req.world, body: req.body || {}, by: by(req) });
  answer(res, s, 201);
});

exports.getOne = catchAsync(async (req, res) => answer(res, await load(req)));

exports.update = catchAsync(async (req, res) => answer(res, await suppliers.updateDetails(await load(req), req.body || {})));

exports.renewLink = catchAsync(async (req, res) => {
  const { days, fresh } = req.body || {};
  answer(res, await suppliers.renewLink(await load(req), { days, fresh: fresh === true, by: by(req) }));
});

exports.review = catchAsync(async (req, res) => {
  const { target, state, note, fields } = req.body || {};
  answer(res, await suppliers.review(await load(req), { target, state, note, fields, by: by(req) }));
});

exports.markSeen = catchAsync(async (req, res) => answer(res, await suppliers.markSeen(await load(req))));

exports.emailStep = catchAsync(async (req, res) => {
  const { step, to } = req.body || {};
  answer(res, await suppliers.emailStep(await load(req), { step, to, by: by(req) }));
});

exports.remove = catchAsync(async (req, res) => {
  await suppliers.remove(await load(req));
  res.status(204).json({ status: "success", data: null });
});

/* ───────────────────────── stored bytes (staff and public) ───────────────────────── */

async function sendFile(req, res, s) {
  const row = suppliers.rowOf(s, req.params.key);
  if (!row?.file?.stored) throw AppError.of("NOT_FOUND", 404, "קובץ");
  if (notModified(req, res, `${row.file.stored}-${row.file.uploadedAt ? new Date(row.file.uploadedAt).getTime() : 0}`)) return;
  const file = await suppliers.fileOf(row);
  if (!file) throw AppError.of("NOT_FOUND", 404, "קובץ");
  res.type(file.mime || "application/octet-stream");
  const disposition = suppliers.INLINE_MIMES.has(file.mime) ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name || req.params.key)}`);
  res.send(file.data);
}

async function sendThumb(req, res, s) {
  const row = suppliers.rowOf(s, req.params.key);
  if (!row?.file?.stored) throw AppError.of("NOT_FOUND", 404, "תמונה מוקטנת");
  if (notModified(req, res, `${row.file.stored}-${row.file.uploadedAt ? new Date(row.file.uploadedAt).getTime() : 0}-thumb`)) return;
  const thumb = await suppliers.thumbOf(row);
  if (!thumb) throw AppError.of("NOT_FOUND", 404, "תמונה מוקטנת");
  res.type(thumb.mime);
  res.send(thumb.data);
}

exports.staffFile = catchAsync(async (req, res) => sendFile(req, res, await load(req)));
exports.staffThumb = catchAsync(async (req, res) => sendThumb(req, res, await load(req)));

/* ───────────────────────── public (behind the link) ───────────────────────── */

const resolve = (req) => suppliers.resolveToken({ world: req.world, token: req.params.token });
const publicAnswer = (res, s) => res.status(200).json({ status: "success", data: { view: suppliers.publicView(s) } });

exports.publicView = catchAsync(async (req, res) => publicAnswer(res, await suppliers.noteOpened(await resolve(req))));

exports.publicForm = catchAsync(async (req, res) => publicAnswer(res, await suppliers.submitForm(await resolve(req), req.body || {})));

exports.publicUpload = catchAsync(async (req, res) => {
  const { fileName, mime, data, thumb } = req.body || {};
  if (!data) throw AppError.of("MISSING_FIELDS", 400, "data");
  publicAnswer(res, await suppliers.uploadFile(await resolve(req), { key: req.params.key, fileName, mime, data, thumb }));
});

exports.publicRemove = catchAsync(async (req, res) => publicAnswer(res, await suppliers.removeFile(await resolve(req), req.params.key)));

exports.publicNotApplicable = catchAsync(async (req, res) => {
  const { value } = req.body || {};
  publicAnswer(res, await suppliers.setNotApplicable(await resolve(req), req.params.key, value));
});

exports.publicFile = catchAsync(async (req, res) => sendFile(req, res, await resolve(req)));
exports.publicThumb = catchAsync(async (req, res) => sendThumb(req, res, await resolve(req)));
