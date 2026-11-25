/**
 * @file Week plan routes - the staff's side of the hostels teachers' week
 * census (Eden, 2026-11-18; services/weekPlanService). Mounted at
 * /api/week-plans under the `hostels` family; the teacher's side is under
 * /api/public/week-plans/:token (the handlers below, mounted by
 * routes/publicRoutes).
 * @module routes/weekPlanRoutes
 */

const express = require("express");
const catchAsync = require("../utils/catchAsync");
const plans = require("../services/weekPlanService");
const { linkAnswer } = require("../utils/publicUrl");

const router = express.Router();
const by = (req) => req.actor?.name || req.account?.name || "";
const one = (res, plan, status = 200) => res.status(status).json({ status: "success", data: { plan } });

router.get(
  "/",
  catchAsync(async (req, res) => {
    res.status(200).json({ status: "success", data: await plans.list() });
  })
);
/** POST { teachers: [personId], until?, lang? } - a form for each of them (whoever has one keeps it). */
router.post(
  "/",
  catchAsync(async (req, res) => {
    const made = await plans.open({ teachers: req.body?.teachers, until: req.body?.until, days: req.body?.days, by: by(req), lang: req.body?.lang });
    res.status(201).json({ status: "success", data: { plans: made } });
  })
);
router.get(
  "/:id/link",
  catchAsync(async (req, res) => {
    const { token, expiresAt } = await plans.link(req.params.id);
    res.set("Cache-Control", "private, no-store");
    res.status(200).json({ status: "success", data: { link: linkAnswer(req, `/week/${token}`, token, expiresAt) } });
  })
);
router.post("/:id/sent", catchAsync(async (req, res) => one(res, await plans.markSent({ id: req.params.id, by: by(req) }))));
router.post("/:id/renew", catchAsync(async (req, res) => one(res, await plans.renew({ id: req.params.id, until: req.body?.until, days: req.body?.days }))));
router.post("/:id/lang", catchAsync(async (req, res) => one(res, await plans.setLang({ id: req.params.id, lang: req.body?.lang }))));
router.post("/:id/reopen", catchAsync(async (req, res) => one(res, await plans.reopen({ id: req.params.id }))));
/**
 * POST { teachers: [personId], hostel?, units? } - the form becomes one person's for these teachers; each lesson
 * then names its teacher. `units` (["1", "2"]): the house is several houses, and a lesson belongs to one of them.
 */
router.post("/:id/cover", catchAsync(async (req, res) => one(res, await plans.cover({ id: req.params.id, teachers: req.body?.teachers, hostel: req.body?.hostel, units: req.body?.units }))));
/** A fresh start: what was written so far is set aside (kept, not counted), and the form stands as one not sent yet. */
router.post("/:id/aside", catchAsync(async (req, res) => one(res, await plans.setAside({ id: req.params.id, by: by(req) }))));
router.post("/:id/entries", catchAsync(async (req, res) => one(res, await plans.saveEntry({ id: req.params.id, data: req.body, by: by(req) }), 201)));
router.put("/:id/entries/:eid", catchAsync(async (req, res) => one(res, await plans.saveEntry({ id: req.params.id, entryId: req.params.eid, data: req.body, by: by(req) }))));
/** PUT { state: "ok" | "bad" | null, reason?, note? } - the staff's word on a lesson: right, not right and why, or taken back. */
router.put("/:id/entries/:eid/check", catchAsync(async (req, res) => one(res, await plans.checkEntry({ id: req.params.id, entryId: req.params.eid, state: req.body?.state, reason: req.body?.reason, note: req.body?.note, actor: req.actor || req.account }))));
router.delete("/:id/entries/:eid", catchAsync(async (req, res) => one(res, await plans.removeEntry({ id: req.params.id, entryId: req.params.eid }))));
router.delete(
  "/:id",
  catchAsync(async (req, res) => {
    await plans.remove({ id: req.params.id });
    res.status(204).json({ status: "success", data: null });
  })
);

/* ───────────────────────── the teacher, behind the link (no login) ───────────────────────── */

const view = (res, v, status = 200) => {
  res.set("Cache-Control", "private, no-store");
  res.status(status).json({ status: "success", data: { view: v } });
};
const publicHandlers = {
  view: catchAsync(async (req, res) => view(res, await plans.publicView(req.params.token))),
  addEntry: catchAsync(async (req, res) => view(res, await plans.publicSaveEntry({ token: req.params.token, data: req.body }), 201)),
  saveEntry: catchAsync(async (req, res) => view(res, await plans.publicSaveEntry({ token: req.params.token, entryId: req.params.eid, data: req.body }))),
  removeEntry: catchAsync(async (req, res) => view(res, await plans.publicRemoveEntry({ token: req.params.token, entryId: req.params.eid }))),
  done: catchAsync(async (req, res) => view(res, await plans.publicDone({ token: req.params.token, note: req.body?.note }))),
};

module.exports = router;
module.exports.publicHandlers = publicHandlers;
