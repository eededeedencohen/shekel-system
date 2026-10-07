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

exports.getIncidents = catchAsync(async (req, res) => {
  const rows = await incidents.listIncidents({ world: req.world, person: req.query.person });
  res.status(200).json({ status: "success", results: rows.length, data: { incidents: rows } });
});

exports.createIncident = catchAsync(async (req, res) => {
  const b = req.body || {};
  const { incident, activity } = await incidents.reportIncident({
    world: req.world,
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
  const incident = await incidents.updateIncident({ world: req.world, id: req.params.id, patch, by });
  res.status(200).json({ status: "success", data: { incident } });
});
