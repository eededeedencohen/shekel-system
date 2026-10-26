/**
 * @file fileController - /api/files: the files bucket for a signed-in persona
 * @module controllers/fileController
 * @see services/fileService (the steps), services/fileAccess (who may)
 *
 *   POST   /upload-url      { family, owner: { id, slot }, name, mime, size, thumb } → { fileId, put, thumbPut }
 *   POST   /:id/confirm     { meta } → the family's answer (the intake, the supplier, the document, the invoice…)
 *   GET    /:id/url         ?thumb=1 ?download=1 → { url, expiresAt, mime, name, size }
 *   POST   /urls            { ids, thumb } → { [id]: { url, expiresAt } }
 *   DELETE /:id
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const files = require("../services/fileService");

const actorOf = (req) => ({ req });

exports.uploadUrl = catchAsync(async (req, res) => {
  const b = req.body || {};
  if (!b.family || !b.mime) throw AppError.of("MISSING_FIELDS", 400, "family, mime");
  const out = await files.beginUpload({ actor: actorOf(req), family: b.family, owner: b.owner || {}, name: b.name, mime: b.mime, size: b.size, thumb: b.thumb === true });
  res.status(201).json({ status: "success", data: out });
});

exports.confirm = catchAsync(async (req, res) => {
  const out = await files.confirmUpload({ actor: actorOf(req), fileId: req.params.id, meta: (req.body || {}).meta || req.body || {} });
  res.status(200).json({ status: "success", data: out });
});

exports.url = catchAsync(async (req, res) => {
  const out = await files.signedRead({ actor: actorOf(req), fileId: req.params.id, thumb: req.query.thumb === "1", download: req.query.download === "1" });
  res.set("Cache-Control", "private, no-store");
  res.status(200).json({ status: "success", data: out });
});

exports.urls = catchAsync(async (req, res) => {
  const b = req.body || {};
  const out = await files.signedReads({ actor: actorOf(req), ids: Array.isArray(b.ids) ? b.ids : [], thumb: b.thumb === true });
  res.set("Cache-Control", "private, no-store");
  res.status(200).json({ status: "success", data: { urls: out } });
});

exports.remove = catchAsync(async (req, res) => {
  await files.remove({ actor: actorOf(req), fileId: req.params.id });
  res.status(204).json({ status: "success", data: null });
});
