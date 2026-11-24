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

module.exports = router;
