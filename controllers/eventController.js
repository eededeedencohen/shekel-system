/**
 * @file Event controller — תרבות לכל events + their registrations
 * @module controllers/eventController
 *
 * Thin HTTP layer over services/cultureService. The acting person comes in
 * the body as `by` (a people id) — the service decides whether that person
 * may do the thing (culture staff / the student themself).
 */

const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const culture = require("../services/cultureService");

const PERSON_SELECT = "firstName lastName email phone gender birthDate avatar deletedAt";

/** GET /api/events?status=&from=&to=&upcoming=true */
exports.getEvents = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  if (req.query.from || req.query.to || req.query.upcoming === "true") {
    filter.date = {};
    if (req.query.upcoming === "true") filter.date.$gte = new Date(Date.now() - 86400000);
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }
  const events = await Event.find(filter)
    .populate({ path: "created.by", select: "firstName lastName" })
    .populate({ path: "published.by", select: "firstName lastName" })
    .sort({ date: 1 });

  // Seat/waitlist counts in one aggregation — the list renders capacity bars.
  const counts = await EventRegistration.aggregate([
    { $match: { event: { $in: events.map((e) => e._id) } } },
    { $group: { _id: { event: "$event", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const byEvent = {};
  for (const c of counts) {
    const k = String(c._id.event);
    byEvent[k] = byEvent[k] || { registered: 0, waitlisted: 0, cancelled: 0 };
    byEvent[k][c._id.status] = c.n;
  }
  const data = events.map((e) => ({
    ...e.toObject(),
    counts: byEvent[String(e._id)] || { registered: 0, waitlisted: 0, cancelled: 0 },
  }));
  res.status(200).json({ status: "success", results: data.length, data: { events: data } });
});

/** GET /api/events/:id — the event + every registration (populated). */
exports.getEventById = catchAsync(async (req, res, next) => {
  const event = await Event.findOne({ _id: req.params.id, world: req.world })
    .populate({ path: "created.by", select: "firstName lastName" })
    .populate({ path: "published.by", select: "firstName lastName" });
  if (!event) return next(AppError.of("NOT_FOUND", 404, "אירוע"));
  const registrations = await EventRegistration.find({ event: event._id })
    .populate({ path: "student", select: PERSON_SELECT })
    .populate({ path: "history.by", select: "firstName lastName" })
    .populate({ path: "waitlist.addedBy", select: "firstName lastName" })
    .populate({ path: "attendance.reportedBy", select: "firstName lastName" })
    .sort({ status: 1, "waitlist.position": 1, registeredAt: 1 });
  res.status(200).json({ status: "success", data: { event, registrations } });
});

/** POST /api/events — body { by*, name*, date*, category?, location?, settings?, … } */
exports.createEvent = catchAsync(async (req, res, next) => {
  if (!req.body.name || !req.body.date) return next(AppError.of("MISSING_FIELDS", 400, "name, date"));
  const event = await culture.createEvent({ world: req.world, by: req.body.by, data: req.body });
  res.status(201).json({ status: "success", data: { event } });
});

/** PUT /api/events/:id — body { by*, …editable fields } */
exports.updateEvent = catchAsync(async (req, res) => {
  const event = await culture.updateEvent({ eventId: req.params.id, world: req.world, by: req.body.by, data: req.body });
  res.status(200).json({ status: "success", data: { event } });
});

/** POST /api/events/:id/publish — body { by* } */
exports.publishEvent = catchAsync(async (req, res) => {
  const event = await culture.publishEvent({ eventId: req.params.id, world: req.world, by: req.body.by });
  res.status(200).json({ status: "success", data: { event } });
});

/** POST /api/events/:id/cancel — body { by*, reason? } */
exports.cancelEvent = catchAsync(async (req, res) => {
  const { event, cancelled } = await culture.cancelEvent({
    eventId: req.params.id, world: req.world, by: req.body.by, reason: req.body.reason,
  });
  res.status(200).json({ status: "success", data: { event, cancelledRegistrations: cancelled } });
});

/** POST /api/events/:id/done — body { by* } */
exports.markEventDone = catchAsync(async (req, res) => {
  const event = await culture.markEventDone({ eventId: req.params.id, world: req.world, by: req.body.by });
  res.status(200).json({ status: "success", data: { event } });
});

/** DELETE /api/events/:id?by= — untouched drafts only */
exports.deleteEvent = catchAsync(async (req, res) => {
  await culture.deleteEvent({ eventId: req.params.id, world: req.world, by: req.query.by || req.body?.by });
  res.status(204).json({ status: "success", data: null });
});

/* ─────────────────────── registrations ─────────────────────── */

/** GET /api/event-registrations?event=&student=&status= */
exports.getRegistrations = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.event) filter.event = req.query.event;
  if (req.query.student) filter.student = req.query.student;
  if (req.query.status) filter.status = { $in: req.query.status.split(",") };
  const registrations = await EventRegistration.find(filter)
    .populate({ path: "event", select: "name date endTime category location status settings" })
    .populate({ path: "student", select: "firstName lastName" })
    .sort({ createdAt: -1 });
  res.status(200).json({ status: "success", results: registrations.length, data: { registrations } });
});

/** POST /api/event-registrations — body { event*, student*, by*, reason?, force?, allowWaitlist?, guest? } */
exports.register = catchAsync(async (req, res, next) => {
  const { event, student, by, reason, force, allowWaitlist, guest } = req.body;
  if (!event || !student) return next(AppError.of("MISSING_FIELDS", 400, "event, student"));
  const registration = await culture.register({
    eventId: event, studentId: student, world: req.world, by, reason,
    force: !!force, allowWaitlist: allowWaitlist !== false, guest: !!guest,
  });
  res.status(201).json({ status: "success", data: { registration } });
});

/** POST /api/event-registrations/:id/cancel — body { by*, reason? } */
exports.cancelRegistration = catchAsync(async (req, res) => {
  const { registration, promoted } = await culture.cancelRegistration({
    registrationId: req.params.id, world: req.world, by: req.body.by, reason: req.body.reason,
  });
  res.status(200).json({ status: "success", data: { registration, promoted } });
});

/** PATCH /api/event-registrations/:id/attendance — body { by*, present (bool|null), note? } */
exports.reportAttendance = catchAsync(async (req, res, next) => {
  if (!("present" in req.body)) return next(AppError.of("MISSING_FIELDS", 400, "present"));
  const registration = await culture.reportAttendance({
    registrationId: req.params.id, world: req.world, by: req.body.by,
    present: req.body.present, note: req.body.note,
  });
  res.status(200).json({ status: "success", data: { registration } });
});
