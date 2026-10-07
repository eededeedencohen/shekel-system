/**
 * @file Incident service - דיווח אירוע חריג
 * @module services/incidentService
 *
 * The Ministry of Health procedure the social worker described
 * (2026-10-07): an incident is reported with the exact time, the reporter
 * and their role, a primary classification (פגיעה פיזית / אלימות /
 * התדרדרות רפואית / אחר) and a secondary one, a factual description, the
 * immediate actions, and who was told among the managers. The row lives
 * in `incidents`; the person's activities tab mirrors it as an "incident"
 * activity so the record reads in one place.
 */

const Incident = require("../models/Incident");
const Activity = require("../models/Activity");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { INCIDENT_PRIMARY, INCIDENT_PRIMARY_KEYS } = require("../utils/domain");
const activities = require("./activityService");

const clean = (s, max = 4000) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);
const primaryLabel = (k) => INCIDENT_PRIMARY.find((p) => p.key === k)?.label || k;

function activityTitle(inc) {
  return [primaryLabel(inc.primary), inc.secondary].filter(Boolean).join(" · ");
}
function activityFields(inc) {
  return {
    reportedBy: [inc.reportedBy?.name, inc.reportedBy?.role].filter(Boolean).join(" · "),
    actions: inc.actions,
    managerNotified: inc.managerNotified?.name ? `${inc.managerNotified.name}${inc.managerNotified.at ? ` · ${new Date(inc.managerNotified.at).toLocaleDateString("he-IL")}` : ""}` : undefined,
  };
}

/** A new report (+ its mirror on the person's record). */
async function reportIncident({ world, person, at, reportedBy, primary, secondary, description, actions, managerNotified, by }) {
  const p = await Person.findById(person).select("world deletedAt");
  if (!p) throw AppError.of("NOT_FOUND", 404, "אדם");
  if (p.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (p.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  const when = at ? new Date(at) : null;
  const name = clean(reportedBy?.name, 80);
  const text = clean(description, 8000);
  if (!when || isNaN(when.getTime()) || !name || !INCIDENT_PRIMARY_KEYS.includes(primary) || !text) {
    throw AppError.of("INCIDENT_INVALID", 400);
  }
  const notified = managerNotified?.name
    ? { name: clean(managerNotified.name, 80), at: managerNotified.at ? new Date(managerNotified.at) : new Date() }
    : undefined;
  if (notified?.at && isNaN(notified.at.getTime())) throw AppError.of("INVALID_DATE", 400);
  const incident = await Incident.create({
    world,
    person,
    at: when,
    reportedBy: { name, role: clean(reportedBy?.role, 80) },
    primary,
    secondary: clean(secondary, 120),
    description: text,
    actions: clean(actions, 4000),
    managerNotified: notified,
    by,
  });
  const activity = await activities.addActivity({
    world,
    person,
    kind: "incident",
    at: when,
    by,
    title: activityTitle(incident),
    body: text,
    fields: activityFields(incident),
    related: { incident: incident._id },
    skipRequired: true,
  });
  incident.activity = activity._id;
  await incident.save();
  return { incident, activity };
}

/** Later facts: the manager was told, more actions, a corrected classification. */
async function updateIncident({ world, id, patch = {}, by }) {
  const incident = await Incident.findOne({ _id: id, world });
  if (!incident) throw AppError.of("NOT_FOUND", 404, "אירוע חריג");
  if (patch.managerNotified !== undefined) {
    incident.managerNotified = patch.managerNotified?.name
      ? { name: clean(patch.managerNotified.name, 80), at: patch.managerNotified.at ? new Date(patch.managerNotified.at) : new Date() }
      : undefined;
  }
  if (patch.actions !== undefined) incident.actions = clean(patch.actions, 4000);
  if (patch.description !== undefined) incident.description = clean(patch.description, 8000) || incident.description;
  if (patch.secondary !== undefined) incident.secondary = clean(patch.secondary, 120);
  if (patch.primary !== undefined) {
    if (!INCIDENT_PRIMARY_KEYS.includes(patch.primary)) throw AppError.of("INCIDENT_INVALID", 400);
    incident.primary = patch.primary;
  }
  if (patch.at !== undefined) {
    const when = new Date(patch.at);
    if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
    incident.at = when;
  }
  await incident.save();
  if (incident.activity) {
    await Activity.updateOne(
      { _id: incident.activity },
      { $set: { at: incident.at, title: activityTitle(incident), body: incident.description, fields: activityFields(incident), editedAt: new Date(), editedBy: by } }
    );
  }
  return incident;
}

/** Newest first (of one person, or of the world). */
function listIncidents({ world, person }) {
  const filter = { world };
  if (person) filter.person = person;
  return Incident.find(filter).sort({ at: -1 });
}

module.exports = { reportIncident, updateIncident, listIncidents, primaryLabel };
