/**
 * @file Incident controller - /api/incidents (דיווח אירוע חריג)
 * @module controllers/incidentController
 *
 *   GET    /?person=     newest first
 *   POST   /             { person*, at*, reportedBy{name*, role}, primary*, secondary, description*, actions, managerNotified{name, at}, by }
 *   PATCH  /:id          { managerNotified, actions, description, secondary, primary, at, by }
 *
 * Every rule lives in services/incidentService.
 */

const catchAsync = require("../utils/catchAsync");
const incidents = require("../services/incidentService");
const lens = require("../services/lensService");

exports.getIncidents = catchAsync(async (req, res) => {
  // the reports on the acting persona's people only (lensService)
  const persons = await lens.scopeOf(req).people();
  const rows = await incidents.listIncidents({ person: req.query.person, persons });
  res.status(200).json({ status: "success", results: rows.length, data: { incidents: rows } });
});

exports.createIncident = catchAsync(async (req, res) => {
  const b = req.body || {};
  await lens.assertPerson(req, b.person); // on one of the persona's own people
  const { incident, activity } = await incidents.reportIncident({
    person: b.person,
    at: b.at,
    reportedBy: b.reportedBy,
    primary: b.primary,
    secondary: b.secondary,
    description: b.description,
    actions: b.actions,
    managerNotified: b.managerNotified,
    by: b.by,
  });
  res.status(201).json({ status: "success", data: { incident, activity } });
});

exports.updateIncident = catchAsync(async (req, res) => {
  const { by, ...patch } = req.body || {};
  const incident = await incidents.updateIncident({ id: req.params.id, patch, by });
  res.status(200).json({ status: "success", data: { incident } });
});
