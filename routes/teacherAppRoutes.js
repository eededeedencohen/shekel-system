/**
 * @file /api/teacher - the teachers' app (Eden, 2026-11-16)
 * @module routes/teacherAppRoutes
 *
 * Open to a teacher's account alone (the ACTING one: the super admin
 * viewing as a teacher reads exactly what that teacher reads). Every
 * handler works on the account's own person - the request never names a
 * teacher (services/teacherAppService).
 */

const express = require("express");
const router = express.Router();
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { whoAmI } = require("../utils/actor");
const service = require("../services/teacherAppService");
const rounds = require("../services/invoiceRoundService");
const files = require("../services/fileService");
const storedFiles = require("../services/storedFiles");
const StoredFile = require("../models/StoredFile");
const { uploadLimiter } = require("../utils/security");

router.use((req, res, next) => {
  if (req.actor && req.actor.kind === "teacher" && req.actor.person) return next();
  return next(AppError.of("OUT_OF_SCOPE", 403));
});

const ok = (res, data, status = 200) => res.status(status).json({ status: "success", data });

router.get(
  "/board",
  catchAsync(async (req, res) => {
    ok(res, await service.board(whoAmI(req).personId));
  })
);

router.put(
  "/attendance",
  catchAsync(async (req, res) => {
    ok(res, { lesson: await service.markAttendance(whoAmI(req).personId, req.body) });
  })
);

router.patch(
  "/availability",
  catchAsync(async (req, res) => {
    ok(res, { availability: await service.saveAvailability(whoAmI(req).personId, req.body?.windows) });
  })
);

/* ───────── the month's invoice (2026-11-16: the college's teachers get no link - it is here) ─────────
 * The same request the link opened, reached by who the teacher is (services/invoiceRoundService, "the teachers'
 * app"); the bucket is reached through the link's own actor shape, which never reads a token.
 */

const me = (req) => whoAmI(req).personId;
const viewing = (req) => String(req.actor?._id) !== String(req.account?._id); // the super admin's preview
const mine = async (req, { write = false } = {}) => {
  const hit = await rounds.loadTeacherRequest({ teacherId: me(req), requestId: req.params.rid });
  if (write) rounds.assertMonthOpen(hit.round);
  return hit;
};
/** The month as the app reads it; every lesson says whether it still waits ("ahead" / "report") before it may be ticked. */
const view = async (res, r, round, status = 200) => {
  const v = await rounds.appView(r, round);
  const waits = await service.sessionsWaiting(r.teacher, r.sessions);
  for (const c of v.courses) for (const s of c.sessions) s.waits = waits.get(String(s._id)) || null;
  return ok(res, { view: v }, status);
};
const declared = (b = {}) => ({ number: b.number, amount: b.amount, reason: b.reason, explanation: b.explanation });
const actorOf = (r) => ({ token: { kind: "invoiceRequest", request: r } });

router.get(
  "/invoices",
  catchAsync(async (req, res) => {
    ok(res, { months: await rounds.teacherMonths({ teacherId: me(req) }) });
  })
);

router.post(
  "/invoices",
  catchAsync(async (req, res) => {
    const r = await rounds.ensureTeacherRequest({ teacherId: me(req), month: req.body?.month });
    await view(res, r, null, 201);
  })
);

router.get(
  "/invoices/:rid",
  catchAsync(async (req, res) => {
    const { r, round } = await mine(req);
    // the teacher opened his month - noted as the link's opening was; the super admin looking is not the teacher
    await view(res, viewing(req) ? r : await rounds.noteOpened(r), round);
  })
);

router.post(
  "/invoices/:rid/upload-url",
  uploadLimiter,
  catchAsync(async (req, res) => {
    const { r } = await mine(req, { write: true });
    const b = req.body || {};
    if (!b.mime) throw AppError.of("MISSING_FIELDS", 400, "mime");
    ok(res, await files.beginUpload({ actor: actorOf(r), family: "invoices", owner: {}, name: b.name, mime: b.mime, size: b.size, thumb: b.thumb === true }), 201);
  })
);

router.post(
  "/invoices/:rid/uploads/:fileId/confirm",
  catchAsync(async (req, res) => {
    const { r, round } = await mine(req, { write: true });
    // only a file this teacher began (the link's own check looks at the kind of the token alone)
    const row = /^[0-9a-f]{24}$/i.test(req.params.fileId) && (await StoredFile.findOne({ _id: req.params.fileId, family: "invoices", "owner.kind": "person", "owner.id": r.teacher }).select("_id").lean());
    if (!row) throw AppError.of("NOT_FOUND", 404, "קובץ");
    // only lessons that took place and were reported go on an invoice
    const waits = await service.sessionsWaiting(r.teacher, r.sessions);
    const picked = Array.isArray((req.body || {}).sessions) ? req.body.sessions.map(String) : [];
    if (picked.some((id) => waits.has(id))) throw AppError.of("INVOICE_LESSON_NOT_REPORTED", 400);
    await files.confirmUpload({ actor: actorOf(r), fileId: req.params.fileId, meta: { sessions: (req.body || {}).sessions, ...declared(req.body) } });
    const again = await rounds.loadTeacherRequest({ teacherId: me(req), requestId: req.params.rid });
    await view(res, again.r, round);
  })
);

router.patch(
  "/invoices/:rid/invoices/:iid",
  catchAsync(async (req, res) => {
    const { r, round } = await mine(req, { write: true });
    await view(res, await rounds.updateDeclared(r, req.params.iid, declared(req.body)), round);
  })
);

router.delete(
  "/invoices/:rid/invoices/:iid",
  catchAsync(async (req, res) => {
    const { r, round } = await mine(req, { write: true });
    await view(res, await rounds.removeInvoice(r, req.params.iid), round);
  })
);

router.post(
  "/invoices/:rid/done",
  catchAsync(async (req, res) => {
    const { r, round } = await mine(req, { write: true });
    await view(res, await rounds.complete(r, { note: req.body?.note }), round);
  })
);

/** A plain link to the invoice's picture (the session cookie rides on it): a 302 to a signed read. */
router.get(
  "/invoices/:rid/invoices/:iid/image",
  catchAsync(async (req, res) => {
    const thumb = req.query.thumb === "1";
    const { r } = await mine(req);
    const inv = await rounds.invoiceOfRequest(r, req.params.iid);
    if (await storedFiles.redirectIfRemote(req, res, inv.file, { thumb })) return;
    if (thumb && (await storedFiles.redirectIfRemote(req, res, inv.file))) return;
    throw AppError.of("NOT_FOUND", 404, thumb ? "תמונה מוקטנת" : "קובץ החשבונית");
  })
);

module.exports = router;
