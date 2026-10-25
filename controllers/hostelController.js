/**
 * @file Hostel controller - the managed hostel entity
 * @module controllers/hostelController
 */

const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { HOSTEL_KIND_KEYS, HOSTEL_CONTACT_ROLE_KEYS } = require("../utils/domain");

/** The writable fields of the body, trimmed; `contact` as a whole object. */
const clean = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);

/**
 * The house's own people, as sent: every row needs a name and a known
 * role (HOSTEL_CONTACT_ROLES); the rest is optional. Rows keep their ids
 * when the client sends them back, so a diary line "about" a contact
 * could point at it later.
 */
function pickContacts(list) {
  if (!Array.isArray(list)) throw AppError.of("HOSTEL_CONTACT_INVALID", 400);
  return list.map((c) => {
    const name = clean(c?.name, 80);
    const role = clean(c?.role, 20);
    if (!name || !HOSTEL_CONTACT_ROLE_KEYS.includes(role)) throw AppError.of("HOSTEL_CONTACT_INVALID", 400);
    const row = { name, role, phone: clean(c.phone, 30), email: clean(c.email, 120).toLowerCase(), note: clean(c.note, 300) };
    if (c._id) row._id = c._id;
    return row;
  });
}

function pickDetails(body) {
  const out = {};
  for (const k of Hostel.EDITABLE) {
    if (!(k in body)) continue;
    if (k === "contact") {
      const c = body.contact || {};
      out.contact = { name: c.name || "", role: c.role || "", phone: c.phone || "" };
    } else if (k === "contacts") out.contacts = pickContacts(body.contacts);
    else if (k === "kind") {
      if (!HOSTEL_KIND_KEYS.includes(body.kind)) throw AppError.of("HOSTEL_KIND_INVALID", 400);
      out.kind = body.kind;
    } else if (k === "approvals") {
      // the Ministry's number: a whole number, or nothing
      const n = body.approvals === "" || body.approvals == null ? null : Number(body.approvals);
      out.approvals = Number.isInteger(n) && n >= 0 ? n : null;
    } else if (k === "since") {
      const d = body.since ? new Date(body.since) : null;
      out.since = d && !Number.isNaN(d.getTime()) ? d : null;
    } else out[k] = body[k];
  }
  return out;
}

exports.getHostels = catchAsync(async (req, res) => {
  const hostels = await Hostel.find().sort({ name: 1 });
  res.status(200).json({ status: "success", results: hostels.length, data: { hostels } });
});

exports.getHostel = catchAsync(async (req, res, next) => {
  const hostel = await Hostel.findOne({ _id: req.params.id });
  if (!hostel) return next(AppError.of("NOT_FOUND", 404, "הוסטל"));
  res.status(200).json({ status: "success", data: { hostel } });
});

exports.createHostel = catchAsync(async (req, res) => {
  const hostel = await Hostel.create({ ...pickDetails(req.body), name: req.body.name });
  res.status(201).json({ status: "success", data: { hostel } });
});

exports.updateHostel = catchAsync(async (req, res, next) => {
  const hostel = await Hostel.findOne({ _id: req.params.id });
  if (!hostel) return next(AppError.of("NOT_FOUND", 404, "הוסטל"));
  const patch = pickDetails(req.body);
  if ("name" in patch && !String(patch.name || "").trim()) {
    return next(AppError.of("MISSING_FIELDS", 400, "שם הוסטל"));
  }
  for (const [k, v] of Object.entries(patch)) hostel[k] = v;
  await hostel.save();
  res.status(200).json({ status: "success", data: { hostel } });
});

exports.deleteHostel = catchAsync(async (req, res, next) => {
  const hostel = await Hostel.findOne({ _id: req.params.id });
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
