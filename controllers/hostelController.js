/**
 * @file Hostel controller — the managed hostel entity
 * @module controllers/hostelController
 */

const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getHostels = catchAsync(async (req, res) => {
  const hostels = await Hostel.find({ world: req.world }).sort({ name: 1 });
  res.status(200).json({ status: "success", results: hostels.length, data: { hostels } });
});

exports.createHostel = catchAsync(async (req, res) => {
  const hostel = await Hostel.create({ name: req.body.name, world: req.world });
  res.status(201).json({ status: "success", data: { hostel } });
});

exports.updateHostel = catchAsync(async (req, res, next) => {
  const hostel = await Hostel.findOne({ _id: req.params.id, world: req.world });
  if (!hostel) return next(AppError.of("NOT_FOUND", 404, "הוסטל"));
  for (const k of ["name", "active"]) if (k in req.body) hostel[k] = req.body[k];
  await hostel.save();
  res.status(200).json({ status: "success", data: { hostel } });
});

exports.deleteHostel = catchAsync(async (req, res, next) => {
  const hostel = await Hostel.findOne({ _id: req.params.id, world: req.world });
  if (!hostel) return next(AppError.of("NOT_FOUND", 404, "הוסטל"));
  const [tracks, venues, residents, managers] = await Promise.all([
    Cycle.countDocuments({ hostel: hostel._id }),
    Cycle.countDocuments({ "venue.hostel": hostel._id }),
    Profile.countDocuments({ "residence.hostel": hostel._id }),
    Profile.countDocuments({ hostels: hostel._id }),
  ]);
  if (tracks || venues || residents || managers) {
    return next(AppError.of("REFERENCED_BLOCKED", 409, `${tracks + venues} מחזורים, ${residents + managers} אנשים`));
  }
  await Hostel.deleteOne({ _id: hostel._id });
  res.status(204).json({ status: "success", data: null });
});
