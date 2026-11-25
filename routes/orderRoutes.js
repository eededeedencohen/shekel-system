/**
 * @file /api/order - putting the students and the courses in order
 * @module routes/orderRoutes
 * @see services/orderService
 *
 * Mounted for the college managers and the super admin (app.js, the "order"
 * family). Every write is also written to the journal with what was before
 * and what is after; the journal itself (GET /log) is the super admin's alone.
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const { requireSuper } = require("../utils/auth");
const order = require("../services/orderService");

const router = express.Router();
const answer = (fn) => catchAsync(async (req, res) => res.status(200).json({ status: "success", data: await fn(req) }));

router.get("/", answer(order.board));
router.get("/log", requireSuper, answer(order.journal));
router.post("/marks", answer(order.mark));
router.post("/links", answer(order.link));
router.post("/seats/off", answer(order.seatOff));
router.post("/seats/on", answer(order.seatOn));
router.put("/teachers/:id/windows", answer(order.windows));
router.delete("/courses/:id", answer(order.courseOff));

module.exports = router;
