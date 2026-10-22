/**
 * @file hostelReportController - the hostel's attendance draft: the
 * coordinator's side under /api/hostel-reports (the `hostels` family), the
 * house's side under /api/public/hostel-reports/:token (no login), and the
 * Ministry of Health's monthly Excel.
 * @module controllers/hostelReportController
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const reports = require("../services/hostelReportService");

const by = (req) => req.actor?.name || req.account?.name || "";
const answer = (res, report, status = 200) => res.status(status).json({ status: "success", data: { report } });

/* ───────────────────────── staff ───────────────────────── */

exports.list = catchAsync(async (req, res) => {
  const list = await reports.listReports({ world: req.world });
  res.status(200).json({ status: "success", results: list.length, data: { reports: list } });
});

/** POST { month, hostel? } - the month for every house, or for one. */
exports.open = catchAsync(async (req, res) => {
  const list = await reports.openMonth({ world: req.world, month: req.body?.month, hostelId: req.body?.hostel || null, by: by(req) });
  res.status(201).json({ status: "success", results: list.length, data: { reports: list } });
});

exports.getOne = catchAsync(async (req, res) => answer(res, await reports.getReport({ world: req.world, reportId: req.params.id })));
exports.markSent = catchAsync(async (req, res) => answer(res, await reports.markSent({ world: req.world, reportId: req.params.id, by: by(req) })));
exports.renew = catchAsync(async (req, res) => answer(res, await reports.renew({ world: req.world, reportId: req.params.id, days: req.body?.days })));
exports.reopen = catchAsync(async (req, res) => answer(res, await reports.reopen({ world: req.world, reportId: req.params.id })));
exports.setNote = catchAsync(async (req, res) => answer(res, await reports.setStaffNote({ world: req.world, reportId: req.params.id, note: req.body?.note })));
exports.approveSession = catchAsync(async (req, res) => answer(res, await reports.approveSession({ world: req.world, reportId: req.params.id, sessionId: req.params.sid, by: by(req) })));
exports.approveAll = catchAsync(async (req, res) => answer(res, await reports.approveAll({ world: req.world, reportId: req.params.id, by: by(req) })));
exports.resolveExtra = catchAsync(async (req, res) => {
  const { person, firstName, lastName, gender } = req.body || {};
  if (!person && !firstName) throw AppError.of("MISSING_FIELDS", 400, "person / firstName");
  answer(res, await reports.resolveExtra({ world: req.world, reportId: req.params.id, extraId: req.params.xid, person, firstName, lastName, gender, by: by(req) }));
});
exports.resolveLeft = catchAsync(async (req, res) => answer(res, await reports.resolveLeft({ world: req.world, reportId: req.params.id, leftId: req.params.lid, by: by(req) })));

exports.remove = catchAsync(async (req, res) => {
  await reports.deleteReport({ world: req.world, reportId: req.params.id });
  res.status(204).json({ status: "success", data: null });
});

/** GET /ministry?month=YYYY-MM - the rows as JSON (the page's preview). */
exports.ministry = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await reports.ministryRows({ world: req.world, month: req.query.month }) });
});

/** GET /ministry.xlsx?month=YYYY-MM - her Excel, as a download. */
exports.ministryXlsx = catchAsync(async (req, res) => {
  const { buffer, fileName } = await reports.ministryXlsx({ world: req.world, month: req.query.month });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(buffer);
});

/* ───────────────────────── the house, behind the link ───────────────────────── */

const resolve = (req) => reports.resolveToken({ world: req.world, token: req.params.token });
const publicAnswer = async (res, r) => res.status(200).json({ status: "success", data: { view: { ...(await reports.publicView(r)), world: r.world } } });

exports.publicView = catchAsync(async (req, res) => publicAnswer(res, await reports.noteOpened(await reports.syncSessions(await resolve(req)))));
exports.publicSession = catchAsync(async (req, res) => publicAnswer(res, await reports.setSession(await resolve(req), req.params.sid, { state: req.body?.state, marks: req.body?.marks })));
exports.publicAddExtra = catchAsync(async (req, res) => publicAnswer(res, await reports.addExtra(await resolve(req), req.body || {})));
exports.publicRemoveExtra = catchAsync(async (req, res) => publicAnswer(res, await reports.removeExtra(await resolve(req), req.params.xid)));
exports.publicAddLeft = catchAsync(async (req, res) => publicAnswer(res, await reports.addLeft(await resolve(req), req.body || {})));
exports.publicRemoveLeft = catchAsync(async (req, res) => publicAnswer(res, await reports.removeLeft(await resolve(req), req.params.lid)));
exports.publicDone = catchAsync(async (req, res) => publicAnswer(res, await reports.complete(await resolve(req), { note: req.body?.note })));
