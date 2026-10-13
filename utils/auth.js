/**
 * @file auth - the session cookie and the gate in front of the API
 * @module utils/auth
 *
 * The browser carries the session in an HttpOnly cookie (so plain links -
 * a thumbnail's <img src>, a book cover - are signed in as well). The API
 * is closed to anyone without a live session, except what has to work
 * signed out: the health check, the public sign-up pages (/api/public) and
 * the sign-in / reset-link routes themselves.
 *
 * Tests: the suites from before passwords run signed in as a super admin
 * (NODE_ENV=test), unless AUTH_ENFORCE=1 - the auth tests set it.
 */

const AppError = require("./AppError");
const auth = require("../services/authService");

const COOKIE = "shekel_session";
const MAX_AGE_S = 30 * 24 * 3600;

/** The session token from the cookie (or an `Authorization: Bearer` header). */
function tokenOf(req) {
  const h = req.get("authorization");
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  const raw = req.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const secure = (req) => req.secure || req.get("x-forwarded-proto") === "https";

function setSessionCookie(req, res, token) {
  res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure(req) ? "; Secure" : ""}`);
}

function clearSessionCookie(req, res) {
  res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? "; Secure" : ""}`);
}

/** Open without a session (paths under /api). */
const OPEN = [/^\/health$/, /^\/public(\/|$)/, /^\/auth\/(login|logout|forgot)$/, /^\/auth\/reset\/[^/]+$/];

const TEST_ACCOUNT = { _id: null, username: "test", name: "בדיקות", title: "", kind: "super", active: true };
const bypass = () => process.env.NODE_ENV === "test" && process.env.AUTH_ENFORCE !== "1";

/**
 * "צפה בתור" on the server (Eden, 2026-10-13: viewing as someone, the
 * super admin has that person's permissions and acts in their name). The
 * client sends the viewed account's id in `X-Acting-As`; only a SUPER
 * account may borrow, and only an active account can be borrowed -
 * otherwise the header is ignored and the actor is the account itself.
 * `req.account` stays who is signed in; `req.actor` is who acts.
 */
const ACTING_HEADER = "x-acting-as";
async function actorOf(req) {
  const account = req.account;
  const wanted = String(req.get(ACTING_HEADER) || "").trim();
  if (!account || account.kind !== "super" || !wanted || wanted === String(account._id)) return account;
  const borrowed = await auth.accountById(wanted);
  return borrowed && borrowed.active ? borrowed : account;
}

/** Mounted on /api: sets req.account (signed in) and req.actor (acting), or answers 401. */
async function authenticate(req, res, next) {
  try {
    if (bypass()) {
      req.account = TEST_ACCOUNT;
      req.actor = TEST_ACCOUNT;
      return next();
    }
    const token = tokenOf(req);
    req.account = token ? await auth.accountForToken(token) : null;
    if (req.account) {
      req.sessionToken = token;
      req.actor = await actorOf(req);
    }
    if (req.account || OPEN.some((re) => re.test(req.path))) return next();
    return next(AppError.of("AUTH_REQUIRED", 401));
  } catch (err) {
    return next(err);
  }
}

/** Only the super admin (the users page, the database explorer) - as the ACTING one: viewing as someone else closes these. */
function requireSuper(req, res, next) {
  if (req.actor && req.actor.kind === "super") return next();
  return next(AppError.of("AUTH_FORBIDDEN", 403));
}

module.exports = { COOKIE, tokenOf, setSessionCookie, clearSessionCookie, authenticate, requireSuper };
