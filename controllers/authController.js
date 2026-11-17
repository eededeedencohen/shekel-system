/**
 * @file Auth + staff accounts controller
 * @module controllers/authController
 *
 * /api/auth      - sign in / out, who am I, my password, "שכחתי סיסמה",
 *                  the reset link page, the staff directory
 * /api/accounts  - the users page (super admin only)
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const auth = require("../services/authService");
const { setSessionCookie, clearSessionCookie, tokenOf } = require("../utils/auth");
const { clientIp } = require("../utils/clientIp");
const presence = require("../services/presenceService");

const ok = (res, data, code = 200) => res.status(code).json({ status: "success", data });

exports.login = catchAsync(async (req, res) => {
  // the lockout keys on req.ip (one hop, like the rate limiter); the sign-in row records the person's own address
  const { account, token } = await auth.login({ ...req.body, ip: req.ip, userAgent: req.get("user-agent"), clientIp: clientIp(req) });
  setSessionCookie(req, res, token);
  ok(res, { account });
});

exports.logout = catchAsync(async (req, res) => {
  await auth.endSession(tokenOf(req));
  clearSessionCookie(req, res);
  ok(res, {});
});

exports.me = (req, res) => ok(res, { account: auth.publicAccount(req.account) });

/** The heartbeat: authenticate already touched the session (services/presenceService); nothing to add. */
exports.ping = (req, res) => res.status(204).end();

/** The goodbye beacon: the tab closed - the session is off the online list until the next touch. */
exports.bye = catchAsync(async (req, res) => {
  await presence.bye(req.sessionId);
  res.status(204).end();
});

exports.changePassword = catchAsync(async (req, res) => {
  const account = await auth.changePassword(req.account._id, req.body || {}, req.sessionToken);
  ok(res, { account });
});

/** My own display preferences (the diary's design) - the signed-in account's, never a borrowed lens's. */
exports.setPrefs = catchAsync(async (req, res) => {
  ok(res, { account: await auth.setPrefs(req.account._id, req.body || {}) });
});

exports.forgot = catchAsync(async (req, res) => {
  await auth.requestReset(req.body?.username);
  ok(res, {});
});

exports.resetInfo = catchAsync(async (req, res) => {
  ok(res, await auth.resetInfo(req.params.token));
});

exports.resetPassword = catchAsync(async (req, res) => {
  const { account, token } = await auth.resetPassword(req.params.token, req.body?.password, req.get("user-agent"), clientIp(req));
  setSessionCookie(req, res, token);
  ok(res, { account });
});

exports.staff = catchAsync(async (req, res, next) => {
  // the directory is the staff's: a teacher's own account has no staff pickers (the teachers' app)
  if (req.account.kind === "teacher") return next(AppError.of("TEACHER_APP_ONLY", 403));
  // the teachers' accounts join only for the super admin's "צפה בתור"
  ok(res, { staff: await auth.staffDirectory({ teachers: req.account.kind === "super" && req.query.teachers === "1" }) });
});

/** PATCH /api/auth/username - one's OWN user name; never while viewing as someone (the account is the signed-in one's). */
exports.changeUsername = catchAsync(async (req, res, next) => {
  if (String(req.actor?._id) !== String(req.account._id)) return next(AppError.of("OUT_OF_SCOPE", 403));
  ok(res, { account: await auth.changeUsername(req.account._id, req.body?.username) });
});

/* ───────── /api/accounts (super admin) ───────── */

exports.listAccounts = catchAsync(async (req, res) => {
  ok(res, { accounts: await auth.listAccounts() });
});

exports.createAccount = catchAsync(async (req, res) => {
  ok(res, { account: await auth.createAccount(req.body || {}) }, 201);
});

exports.updateAccount = catchAsync(async (req, res) => {
  ok(res, { account: await auth.updateAccount(req.params.id, req.body || {}) });
});

exports.createResetLink = catchAsync(async (req, res) => {
  ok(res, await auth.createResetLink(req.params.id, req.body?.token, req.actor?.name), 201);
});
