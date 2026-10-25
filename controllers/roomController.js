/**
 * @file Room controller - rooms with referenced-delete guard
 * @module controllers/roomController
 */

const Room = require("../models/Room");
const Cycle = require("../models/Cycle");
const Lesson = require("../models/Lesson");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getRooms = catchAsync(async (req, res) => {
  const rooms = await Room.find().sort({ name: 1 });
  res.status(200).json({ status: "success", results: rooms.length, data: { rooms } });
});

/**
 * GET /api/rooms/occupancy - every weekly slot booked in a campus room by a
 * live cycle of ANY program, without the people: the room, the day, the
 * hours, which program, the subject. The hostels coordinator's page needs
 * it (Eden with שמרית, 2026-10-14: "נוסיף לך עמוד של זמינות חדרים, שתדעי
 * איזה חדרים פנויים") while her cycles slice holds the hostel courses alone.
 */
exports.getOccupancy = catchAsync(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cycles = await Cycle.find({ status: { $ne: "Cancelled" }, endDate: { $gte: today } })
    .select("subject hostel schedule")
    .populate("subject", "name")
    .lean();
  const slots = [];
  for (const c of cycles) {
    for (const s of c.schedule || []) {
      if (!s.room || !Number.isInteger(s.day) || !s.start || !s.end) continue;
      slots.push({ room: s.room, day: s.day, start: s.start, end: s.end, program: c.hostel ? "hostels" : "college", label: c.subject?.name || "קורס" });
    }
  }
  res.status(200).json({ status: "success", results: slots.length, data: { slots } });
});

exports.getRoomById = catchAsync(async (req, res, next) => {
  const room = await Room.findById(req.params.id);
  if (!room) return next(AppError.of("NOT_FOUND", 404, "חדר"));
  res.status(200).json({ status: "success", data: { room } });
});

exports.createRoom = catchAsync(async (req, res) => {
  const { name, capacity, notes, active } = req.body;
  const room = await Room.create({ name, capacity, notes, active });
  res.status(201).json({ status: "success", data: { room } });
});

exports.updateRoom = catchAsync(async (req, res, next) => {
  const room = await Room.findById(req.params.id);
  if (!room) return next(AppError.of("NOT_FOUND", 404, "חדר"));
  for (const k of ["name", "capacity", "notes", "active"]) if (k in req.body) room[k] = req.body[k];
  await room.save();
  res.status(200).json({ status: "success", data: { room } });
});

/** Deletion refused while any slot / requirement / lesson references it. */
exports.deleteRoom = catchAsync(async (req, res, next) => {
  const room = await Room.findById(req.params.id);
  if (!room) return next(AppError.of("NOT_FOUND", 404, "חדר"));
  const [slots, required, lessons] = await Promise.all([
    Cycle.countDocuments({ "schedule.room": room._id }),
    Cycle.countDocuments({ "matching.requiredRooms": room._id }),
    Lesson.countDocuments({ room: room._id }),
  ]);
  if (slots || required || lessons) {
    return next(AppError.of("REFERENCED_BLOCKED", 409, `${slots + required} מחזורים, ${lessons} שיעורים`));
  }
  await Room.deleteOne({ _id: room._id });
  res.status(204).json({ status: "success", data: null });
});
