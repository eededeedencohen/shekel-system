/**
 * @file /api/tag-plan - the students' tags plan: the super admin's answers and notes
 * @module routes/tagPlanRoutes
 *
 * Mounted behind requireSuper (app.js): the page is his alone, and closed
 * like everything else of his while he is viewing as someone.
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const tagPlan = require("../services/tagPlanService");

const router = express.Router();
const ok = (res, data) => res.status(200).json({ status: "success", data });

router.get(
  "/",
  catchAsync(async (req, res) => ok(res, { plan: await tagPlan.get() }))
);
router.put(
  "/",
  catchAsync(async (req, res) => ok(res, { plan: await tagPlan.set(req.body || {}, req.account?.name || req.account?.username || "") }))
);

// the old sheet's waiting lists, for the model of the waiting-lists tab (real names: kept in the database, never in the code)
router.get(
  "/sheet",
  catchAsync(async (req, res) => ok(res, { sheet: await tagPlan.getSheet() }))
);
router.put(
  "/sheet",
  catchAsync(async (req, res) => ok(res, { sheet: await tagPlan.setSheet(req.body, req.account?.name || req.account?.username || "") }))
);
router.delete(
  "/sheet",
  catchAsync(async (req, res) => ok(res, { sheet: await tagPlan.clearSheet() }))
);

// the old system's students list, for the cross-check tab (real people: kept in the database, never in the code;
// the ID numbers it holds are used for the match alone and are never in an answer)
router.get(
  "/old-list",
  catchAsync(async (req, res) => ok(res, { list: await tagPlan.getOldList() }))
);
router.put(
  "/old-list",
  catchAsync(async (req, res) => ok(res, { list: await tagPlan.setOldList(req.body, req.account?.name || req.account?.username || "") }))
);
router.delete(
  "/old-list",
  catchAsync(async (req, res) => ok(res, { list: await tagPlan.clearOldList() }))
);

module.exports = router;
