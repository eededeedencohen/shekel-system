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
 * live cycle of ANY program, without the students: the room, the day, the
 * hours, which program, the subject, who teaches (the teachers are shared
 * by the programs), the house of a hostels course, the cycle's dates. A
 * room is one room whoever booked it, so every lens that holds one
 * program's cycles alone reads the other's bookings here: the hostels
 * coordinator (Eden with שמרית, 2026-10-14: "נוסיף לך עמוד של זמינות חדרים,
 * שתדעי איזה חדרים פנויים") and the college's managers. `cycle` / `slot`
 * let the page tell the bookings it already holds from the ones it does not.
 */
exports.getOccupancy = catchAsync(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cycles = await Cycle.find({ status: { $ne: "Cancelled" }, endDate: { $gte: today } })
    .select("subject teacher hostel schedule startDate endDate")
    .populate("subject", "name")
    .populate("teacher", "firstName lastName")
    .populate("hostel", "name")
    .lean();
  const slots = [];
  for (const c of cycles) {
    const teacher = c.teacher ? `${c.teacher.firstName || ""} ${c.teacher.lastName || ""}`.trim() || null : null;
    for (const s of c.schedule || []) {
      if (!s.room || !Number.isInteger(s.day) || !s.start || !s.end) continue;
      slots.push({
        cycle: c._id,
        slot: s._id,
        room: s.room,
        day: s.day,
        start: s.start,
        end: s.end,
        program: c.hostel ? "hostels" : "college",
        label: c.subject?.name || "קורס",
        teacher,
        hostel: c.hostel?.name || null,
        startDate: c.startDate,
        endDate: c.endDate,
      });
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
