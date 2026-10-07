/**
 * @file Activity controller - /api/activities (לשונית פעילויות + the templates)
 * @module controllers/activityController
 *
 *   GET    /?person=&kind=         the rows, newest first
 *   POST   /                       { person*, kind*, at, by, title, body, fields, program }
 *   PATCH  /:id                    { at, title, body, fields, by }
 *   DELETE /:id
 *   GET    /templates              every kind's template of the world (stored or default)
 *   GET    /templates/:kind
 *   PUT    /templates/:kind        { title, body, fields[], by } - the world's own version
 *   DELETE /templates/:kind        back to the default
 *
 * Every rule lives in services/activityService.
 */

const catchAsync = require("../utils/catchAsync");
const activities = require("../services/activityService");

exports.getActivities = catchAsync(async (req, res) => {
  const rows = await activities.listActivities({ world: req.world, person: req.query.person, kind: req.query.kind });
  res.status(200).json({ status: "success", results: rows.length, data: { activities: rows } });
});

exports.createActivity = catchAsync(async (req, res) => {
  const b = req.body || {};
  const activity = await activities.addActivity({
    world: req.world,
    person: b.person,
    kind: b.kind,
    at: b.at,
    by: b.by,
    title: b.title,
    body: b.body,
    fields: b.fields,
    program: b.program,
  });
  res.status(201).json({ status: "success", data: { activity } });
});

exports.updateActivity = catchAsync(async (req, res) => {
  const b = req.body || {};
  const activity = await activities.updateActivity({ world: req.world, id: req.params.id, at: b.at, title: b.title, body: b.body, fields: b.fields, by: b.by });
  res.status(200).json({ status: "success", data: { activity } });
});

exports.deleteActivity = catchAsync(async (req, res) => {
  await activities.removeActivity({ world: req.world, id: req.params.id });
  res.status(204).json({ status: "success", data: null });
});

exports.getTemplates = catchAsync(async (req, res) => {
  const templates = await activities.templatesOf(req.world);
  res.status(200).json({ status: "success", results: templates.length, data: { templates } });
});

exports.getTemplate = catchAsync(async (req, res) => {
  const template = await activities.templateOf(req.world, req.params.kind);
  res.status(200).json({ status: "success", data: { template } });
});

exports.saveTemplate = catchAsync(async (req, res) => {
  const b = req.body || {};
  const template = await activities.saveTemplate({ world: req.world, kind: req.params.kind, title: b.title, body: b.body, fields: b.fields, by: b.by });
  res.status(200).json({ status: "success", data: { template } });
});

exports.resetTemplate = catchAsync(async (req, res) => {
  const template = await activities.resetTemplate({ world: req.world, kind: req.params.kind });
  res.status(200).json({ status: "success", data: { template } });
});
