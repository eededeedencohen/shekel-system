/**
 * @file Meta controller — the single source the client reads enums from
 * @module controllers/metaController
 *
 * GET /api/meta/domain replaces every hand-mirrored enum table in the
 * client (the old client/src/lib/pipeline.js drift is impossible now).
 */

const { Profile } = require("../models/profiles");
const { DOMAIN_META, WORLDS, STUDENT_KINDS } = require("../utils/domain");
const catchAsync = require("../utils/catchAsync");

exports.getDomain = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { domain: DOMAIN_META } });
});

/** Student counts per world — feeds the dataset toggle. */
exports.getWorlds = catchAsync(async (req, res) => {
  const rows = await Profile.aggregate([
    { $match: { kind: { $in: STUDENT_KINDS }, active: true } },
    { $group: { _id: { world: "$world", person: "$person" } } },
    { $group: { _id: "$_id.world", students: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(WORLDS.map((w) => [w, 0]));
  for (const r of rows) if (r._id in counts) counts[r._id] = r.students;
  res.status(200).json({ status: "success", data: { counts } });
});
