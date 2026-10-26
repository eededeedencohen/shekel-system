/**
 * @file fileController - /api/files: the files bucket for a signed-in persona
 * @module controllers/fileController
 * @see services/fileService (the steps), services/fileAccess (who may)
 *
 *   POST   /upload-url      { family, owner: { id, slot }, name, mime, size, thumb } → { fileId, put, thumbPut }
 *   POST   /:id/confirm     { meta } → the family's answer (the intake, the supplier, the document, the invoice…)
 *   GET    /:id/url         ?thumb=1 ?download=1 → { url, expiresAt, legacy, mime, name, size }
 *   POST   /urls            { ids, thumb } → { [id]: { url, expiresAt } }
 *   GET    /:id/bytes       the legacy bytes of a file not yet in the bucket (the client's one way to read)
 *   DELETE /:id
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const { notModified } = require("../utils/sendFile");
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

exports.bytes = catchAsync(async (req, res) => {
  const thumb = req.query.thumb === "1";
  if (notModified(req, res, `${req.params.id}${thumb ? "-thumb" : ""}`)) return;
  const got = await files.legacyBytes({ actor: actorOf(req), fileId: req.params.id, thumb });
  if (!got) throw AppError.of("NOT_FOUND", 404, thumb ? "תמונה מוקטנת" : "קובץ");
  res.type(got.mime || "application/octet-stream");
  const inline = !/msword|officedocument/.test(got.mime || "");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(got.name || "file")}`);
  res.send(got.data);
});

exports.remove = catchAsync(async (req, res) => {
  await files.remove({ actor: actorOf(req), fileId: req.params.id });
  res.status(204).json({ status: "success", data: null });
});
