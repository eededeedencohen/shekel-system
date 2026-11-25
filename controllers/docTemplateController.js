/**
 * @file docTemplateController - /api/doc-templates (the staff's written templates)
 * @module controllers/docTemplateController
 *
 *   GET    /               the templates the acting account sees (the super admin: all of them)
 *   POST   /               { name, kind, doc, copiedFrom, audience, viewers } - a template of the acting account's
 *   PATCH  /:id            { name, kind, doc } - the one who made it, and the super admin
 *   DELETE /:id            the one who made it, and the super admin
 *   PUT    /:id/audience   { audience, viewers } - who sees it: the same two
 *
 * Every rule lives in services/docTemplateService.
 */

const catchAsync = require("../utils/catchAsync");
const templates = require("../services/docTemplateService");

const actorOf = (req) => req.actor || req.account;

exports.list = catchAsync(async (req, res) => {
  const rows = await templates.list(actorOf(req));
  res.status(200).json({ status: "success", results: rows.length, data: { templates: rows } });
});

exports.create = catchAsync(async (req, res) => {
  const b = req.body || {};
  const template = await templates.create({ name: b.name, kind: b.kind, doc: b.doc, copiedFrom: b.copiedFrom, audience: b.audience, viewers: b.viewers, actor: actorOf(req) });
  res.status(201).json({ status: "success", data: { template } });
});

exports.update = catchAsync(async (req, res) => {
  const b = req.body || {};
  const template = await templates.update({ id: req.params.id, name: b.name, kind: b.kind, doc: b.doc, actor: actorOf(req) });
  res.status(200).json({ status: "success", data: { template } });
});

exports.setAudience = catchAsync(async (req, res) => {
  const b = req.body || {};
  const template = await templates.setAudience({ id: req.params.id, audience: b.audience, viewers: b.viewers, actor: actorOf(req) });
  res.status(200).json({ status: "success", data: { template } });
});

exports.remove = catchAsync(async (req, res) => {
  await templates.remove({ id: req.params.id, actor: actorOf(req) });
  res.status(204).json({ status: "success", data: null });
});
