/**
 * @file invoiceRoundController - the monthly invoice round: the
 * coordinator's side under /api/invoice-rounds (the `invoices` family), the
 * teacher's side under /api/public/invoices/:token (no login).
 * @module controllers/invoiceRoundController
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const { notModified } = require("../utils/sendFile");
const rounds = require("../services/invoiceRoundService");
const { lensOf } = require("../services/lensService");

const by = (req) => req.actor?.name || req.account?.name || "";

/** Which programs' rounds the acting persona may see: hers alone, or every one. */
function programsOf(req) {
  const lens = lensOf(req.actor);
  if (lens.all) return null;
  if (lens.hostelsOnly) return ["hostels"];
  if (lens.collegeOnly) return ["college"];
  return [];
}

/** A round outside the persona's side reads as not there. */
async function loadVisible(req) {
  const round = await rounds.loadRound({ world: req.world, roundId: req.params.id });
  const programs = programsOf(req);
  if (programs && !programs.includes(round.program)) throw AppError.of("OUT_OF_SCOPE", 403);
  return round;
}

const answer = (res, round, status = 200) => res.status(status).json({ status: "success", data: { round } });

/* ───────────────────────── staff ───────────────────────── */

exports.list = catchAsync(async (req, res) => {
  const list = await rounds.listRounds({ world: req.world, programs: programsOf(req) });
  res.status(200).json({ status: "success", results: list.length, data: { rounds: list } });
});

exports.open = catchAsync(async (req, res) => {
  const program = req.body?.program || "hostels";
  const programs = programsOf(req);
  if (programs && !programs.includes(program)) throw AppError.of("OUT_OF_SCOPE", 403);
  answer(res, await rounds.openRound({ world: req.world, month: req.body?.month, program, by: by(req) }), 201);
});

exports.getOne = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.getRound({ world: req.world, roundId: round._id }));
});

exports.markSent = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.markSent({ world: req.world, roundId: round._id, requestId: req.params.rid, by: by(req) }));
});

exports.renew = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.renew({ world: req.world, roundId: round._id, requestId: req.params.rid, days: req.body?.days }));
});

exports.reopen = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.reopen({ world: req.world, roundId: round._id, requestId: req.params.rid }));
});

exports.setMail = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.setMail({ world: req.world, roundId: round._id, sent: req.body?.sent !== false, by: by(req) }));
});

exports.setNote = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  answer(res, await rounds.setNote({ world: req.world, roundId: round._id, note: req.body?.note }));
});

exports.remove = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  await rounds.deleteRound({ world: req.world, roundId: round._id });
  res.status(204).json({ status: "success", data: null });
});

/** The super admin's corrections (requireSuper on the route): `{ action, … }` → `{ round, did }`. */
exports.admin = catchAsync(async (req, res) => {
  const round = await loadVisible(req);
  const { round: view, did } = await rounds.adminAction(round, req.body || {}, req.actor);
  res.status(200).json({ status: "success", data: { round: view, did } });
});

/* ───────────────────────── the teacher, behind the link ───────────────────────── */

const resolve = (req, opts) => rounds.resolveToken({ world: req.world, token: req.params.token, ...opts });
// the view says which world the link lives in (the page shows a demo world's ribbon; the link itself carries none)
const publicAnswer = async (res, r) => res.status(200).json({ status: "success", data: { view: { ...(await rounds.publicView(r)), world: r.world } } });

// a finished teacher may read the summary after the link expired (decision 12); a signed-in staff member checking
// the link is not the teacher opening it, so it is not noted as opened (decision 8)
exports.publicView = catchAsync(async (req, res) => {
  const r = await resolve(req, { readWhenDone: true });
  publicAnswer(res, req.sessionToken ? r : await rounds.noteOpened(r));
});

exports.publicInvoice = catchAsync(async (req, res) => {
  const { imageData, imageName, thumb, sessions } = req.body || {};
  if (!imageData) throw AppError.of("MISSING_FIELDS", 400, "imageData");
  publicAnswer(res, await rounds.addInvoice(await resolve(req), { imageData, imageName, thumb, sessionIds: sessions }));
});

exports.publicRemoveInvoice = catchAsync(async (req, res) => publicAnswer(res, await rounds.removeInvoice(await resolve(req), req.params.iid)));

exports.publicDone = catchAsync(async (req, res) => publicAnswer(res, await rounds.complete(await resolve(req), { note: req.body?.note })));

exports.publicImage = catchAsync(async (req, res) => {
  const file = await rounds.imageOf(await resolve(req, { readWhenDone: true }), req.params.iid, req.query.thumb === "1");
  if (notModified(req, res, `${file._id}-${file.updatedAt ? new Date(file.updatedAt).getTime() : 0}`)) return;
  res.type(file.mime);
  res.send(file.data);
});
