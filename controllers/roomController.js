/**
 * @file Room controller — world-scoped rooms with referenced-delete guard
 * @module controllers/roomController
 */

const Room = require("../models/Room");
const Cycle = require("../models/Cycle");
const Lesson = require("../models/Lesson");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getRooms = catchAsync(async (req, res) => {
  const rooms = await Room.find({ world: req.world }).sort({ name: 1 });
  res.status(200).json({ status: "success", results: rooms.length, data: { rooms } });
});

exports.getRoomById = catchAsync(async (req, res, next) => {
  const room = await Room.findOne({ _id: req.params.id, world: req.world });
  if (!room) return next(AppError.of("NOT_FOUND", 404, "חדר"));
  res.status(200).json({ status: "success", data: { room } });
});

exports.createRoom = catchAsync(async (req, res) => {
  const { name, capacity, notes, active } = req.body;
  const room = await Room.create({ name, capacity, notes, active, world: req.world });
  res.status(201).json({ status: "success", data: { room } });
});

exports.updateRoom = catchAsync(async (req, res, next) => {
  const room = await Room.findOne({ _id: req.params.id, world: req.world });
  if (!room) return next(AppError.of("NOT_FOUND", 404, "חדר"));
  for (const k of ["name", "capacity", "notes", "active"]) if (k in req.body) room[k] = req.body[k];
  await room.save();
  res.status(200).json({ status: "success", data: { room } });
});

/** Deletion refused while any slot / requirement / lesson references it. */
exports.deleteRoom = catchAsync(async (req, res, next) => {
  const room = await Room.findOne({ _id: req.params.id, world: req.world });
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
