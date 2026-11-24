/**
 * @file /api/wait-lists - the waiting lists of מכללה לכל
 * @module routes/waitListRoutes
 * @see services/waitListService
 *
 * Mounted for the college managers and the super admin (app.js). Every
 * answer is the whole board: { lists, entries }.
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const wait = require("../services/waitListService");

const router = express.Router();
const answer = (fn, status = 200) => catchAsync(async (req, res) => res.status(status).json({ status: "success", data: await fn(req) }));

router.route("/").get(answer(wait.board)).post(answer(wait.createList, 201));
// (static paths before /:id)
router.post("/entries", answer(wait.addEntry, 201));
router.route("/entries/:id").patch(answer(wait.updateEntry)).delete(answer(wait.removeEntry));
router.post("/entries/:id/end", answer(wait.endEntry));
router.post("/entries/:id/back", answer(wait.backEntry));
router.route("/:id").patch(answer(wait.updateList)).delete(answer(wait.removeList));

module.exports = router;
