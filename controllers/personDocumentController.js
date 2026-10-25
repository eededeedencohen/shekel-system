/**
 * @file personDocumentController - a person's own papers (a teacher's
 * syllabus), under /api/people/:id/documents; the full list for the
 * client's slice under /api/people/documents (the lens narrows it).
 * @module controllers/personDocumentController
 */

const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { notModified } = require("../utils/sendFile");
const docs = require("../services/personDocumentService");
const lens = require("../services/lensService");

const by = (req) => req.actor?.name || req.account?.name || "";

exports.listAll = catchAsync(async (req, res) => {
  const persons = await lens.scopeOf(req).people();
  const documents = await docs.list({ persons });
  res.status(200).json({ status: "success", results: documents.length, data: { documents } });
});

exports.listOfPerson = catchAsync(async (req, res) => {
  const documents = await docs.list({ personId: req.params.id });
  res.status(200).json({ status: "success", results: documents.length, data: { documents } });
});

exports.add = catchAsync(async (req, res) => {
  const { kind, label, fileName, mime, data, thumb, note } = req.body || {};
  if (!data) throw AppError.of("MISSING_FIELDS", 400, "data");
  const document = await docs.add({ personId: req.params.id, kind, label, fileName, mime, data, thumb, note, by: by(req) });
  res.status(201).json({ status: "success", data: { document } });
});

exports.remove = catchAsync(async (req, res) => {
  await docs.remove({ personId: req.params.id, docId: req.params.docId });
  res.status(204).json({ status: "success", data: null });
});

exports.file = catchAsync(async (req, res) => {
  const doc = await docs.load({ personId: req.params.id, docId: req.params.docId });
  if (notModified(req, res, `${doc.file}-${new Date(doc.uploadedAt).getTime()}`)) return;
  const file = await docs.fileOf(doc);
  if (!file) throw AppError.of("NOT_FOUND", 404, "קובץ");
  res.type(file.mime || "application/octet-stream");
  const disposition = docs.INLINE_MIMES.has(file.mime) ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name || "document")}`);
  res.send(file.data);
});

exports.thumb = catchAsync(async (req, res) => {
  const doc = await docs.load({ personId: req.params.id, docId: req.params.docId });
  if (notModified(req, res, `${doc.file}-${new Date(doc.uploadedAt).getTime()}-thumb`)) return;
  const thumb = await docs.thumbOf(doc);
  if (!thumb) throw AppError.of("NOT_FOUND", 404, "תמונה מוקטנת");
  res.type(thumb.mime);
  res.send(thumb.data);
});
