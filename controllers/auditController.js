/**
 * @file Audit controller - the activity pages (super admin)
 * @module controllers/auditController
 *
 * /api/audit/overview   who is online + every account summed up
 * /api/audit/presence   who is online (the strip polls this one)
 * /api/audit/logins     the sign-ins, newest first (?account=&before=&limit=)
 * /api/audit/events     the writes, newest first (?user=&verb=&kind=&q=&from=&to=&before=&limit=)
 * /api/audit/users/:id  one account's header: writes by verb, sign-ins in numbers, presence
 */

const catchAsync = require("../utils/catchAsync");
const audit = require("../services/auditService");
const presence = require("../services/presenceService");

const ok = (res, data) => res.status(200).json({ status: "success", data });

exports.overview = catchAsync(async (req, res) => ok(res, await audit.overview()));

exports.presence = catchAsync(async (req, res) => {
  const now = Date.now();
  ok(res, { now: new Date(now), online: await presence.online(now) });
});

exports.logins = catchAsync(async (req, res) => ok(res, await audit.logins(req.query)));

exports.events = catchAsync(async (req, res) => ok(res, await audit.events(req.query)));

exports.user = catchAsync(async (req, res) => ok(res, await audit.userSummary(req.params.id)));

/** POST /api/audit/clear { what: ["events","logins"], user?, olderThanDays? } → { events, logins } deleted. */
exports.clear = catchAsync(async (req, res) => ok(res, await audit.clear(req.body || {})));
