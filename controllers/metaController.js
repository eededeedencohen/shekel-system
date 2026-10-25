/**
 * @file Meta controller - the single source the client reads enums from
 * @module controllers/metaController
 *
 * GET /api/meta/domain replaces every hand-mirrored enum table in the
 * client (the old client/src/lib/pipeline.js drift is impossible now).
 * One list is live: `subjectCategories` = the built-ins + the categories
 * the staff named (services/subjectCategoryService).
 */

const { DOMAIN_META } = require("../utils/domain");
const { allCategories } = require("../services/subjectCategoryService");
const catchAsync = require("../utils/catchAsync");

exports.getDomain = catchAsync(async (req, res) => {
  const subjectCategories = await allCategories();
  res.status(200).json({ status: "success", data: { domain: { ...DOMAIN_META, subjectCategories } } });
});
