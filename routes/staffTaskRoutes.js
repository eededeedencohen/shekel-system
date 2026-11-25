/**
 * @file /api/staff-tasks - the tasks the super admin gives the staff
 * @module routes/staffTaskRoutes
 * @see services/staffTaskService
 *
 * Open to every staff kind (a teacher's account never reaches /api outside
 * its own app - teacherGate): each account reads its own tasks, the super
 * admin every task; who may do what is the service's.
 *
 *   GET    /               the tasks this account sees
 *   POST   /               { title, body, assignee, linkTo, linkLabel, auto } - the super admin gives a task
 *   PATCH  /:id            { title, body, linkTo, linkLabel } - the super admin changes its words
 *   PUT    /:id/done       { done } - one of the two says it is done, or open again
 *   POST   /:id/messages   { text } - a line in the talk about it
 *   PUT    /:id/seen       this account looked at it now
 *   DELETE /:id            the super admin takes it away
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const tasks = require("../services/staffTaskService");

const router = express.Router();
const actorOf = (req) => req.actor || req.account;
const one = (fn, status = 200) =>
  catchAsync(async (req, res) => res.status(status).json({ status: "success", data: { task: await fn({ id: req.params.id, ...(req.body || {}), actor: actorOf(req) }) } }));

router.get(
  "/",
  catchAsync(async (req, res) => {
    const rows = await tasks.list(actorOf(req));
    res.status(200).json({ status: "success", results: rows.length, data: { tasks: rows } });
  })
);
router.post("/", one(tasks.create, 201));
router.put("/:id/done", one(tasks.setDone));
router.post("/:id/messages", one(tasks.say, 201));
router.put("/:id/seen", one(tasks.look));
router
  .route("/:id")
  .patch(one(tasks.update))
  .delete(
    catchAsync(async (req, res) => {
      await tasks.remove({ id: req.params.id, actor: actorOf(req) });
      res.status(204).json({ status: "success", data: null });
    })
  );

module.exports = router;
