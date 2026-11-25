/**
 * @file /api/prepared-actions - changes to the data that wait for the super admin's approval
 * @module routes/preparedActionRoutes
 *
 * Mounted behind requireSuper (app.js): the page is his alone, and closed like
 * everything else of his while he is viewing as someone. An action is written
 * down by POST, and nothing in the data changes until …/approve.
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const actions = require("../services/preparedActionService");

const router = express.Router();
const ok = (res, data, status = 200) => res.status(status).json({ status: "success", data });
const byOf = (req) => req.account?.name || req.account?.username || "";

router.get(
  "/",
  catchAsync(async (req, res) => ok(res, { actions: await actions.list() }))
);
router.get(
  "/count",
  catchAsync(async (req, res) => ok(res, { waiting: await actions.waitingCount() }))
);
router.post(
  "/",
  catchAsync(async (req, res) => ok(res, { action: await actions.create(req.body, byOf(req)) }, 201))
);
router.put(
  "/:id",
  catchAsync(async (req, res) => ok(res, { action: await actions.rewrite(req.params.id, req.body, byOf(req)) }))
);
router.post(
  "/:id/approve",
  catchAsync(async (req, res) => ok(res, { action: await actions.approve(req.params.id, { skip: req.body?.skip, by: byOf(req) }) }))
);
router.post(
  "/:id/cancel",
  catchAsync(async (req, res) => ok(res, { action: await actions.cancel(req.params.id) }))
);

module.exports = router;
