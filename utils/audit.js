/**
 * @file audit - every write someone makes, written down
 * @module utils/audit
 *
 * Eden (2026-10-29): the super admin wants to see, per user, "איזה פעולות
 * הוא עשה - דברים שגרמו לשינוי בבסיס נתונים". Mounted on /api right after
 * the gate: a POST / PUT / PATCH / DELETE by a signed-in account is watched,
 * and once the answer has left with a success status one AuditEvent row is
 * written (models/AuditEvent) with what utils/auditDescribe says it was. The
 * writing happens after the response, so the user never waits for it; a
 * failure to write is logged, never thrown at the user.
 *
 * Not recorded: reads; the sign-in doors (login / logout / forgot / reset -
 * the sign-ins page tells those, models/StaffLogin); the presence ping; the
 * two file routes that only hand out signed URLs (the upload itself is
 * recorded at its confirm); the public token pages (no account there); the
 * read-only database explorer. In the test bypass (no real account) nothing
 * is recorded either - the audit suite signs in for real.
 */

const AuditEvent = require("../models/AuditEvent");
const StaffLogin = require("../models/StaffLogin");
const { describe } = require("./auditDescribe");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP = [/^\/auth\/(login|logout|forgot|ping)$/, /^\/auth\/reset(\/|$)/, /^\/public(\/|$)/, /^\/files\/(upload-url|urls)$/, /^\/db(\/|$)/];

/** The request path under /api - from originalUrl, which no router rewrites. */
const pathOf = (req) => String(req.originalUrl || req.url || "").split("?")[0].replace(/^\/api(?=\/|$)/, "") || "/";

const pending = new Set(); // the writes still in flight (the tests wait for them)

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

async function record({ req, path, status, answer, ms }) {
  const desc = describe({ method: req.method, path, body: req.body, answer });
  const actor = req.actor || req.account;
  await AuditEvent.create({
    at: new Date(),
    account: req.account._id,
    accountName: req.account.name || "",
    actor: actor._id,
    actorName: actor.name || "",
    actorKind: actor.kind || "",
    session: req.sessionId || null,
    method: req.method,
    path,
    route: desc.route,
    status,
    verb: desc.verb,
    title: desc.title,
    kind: desc.kind,
    target: desc.target,
    payload: desc.payload,
    ip: req.ip || "",
    ms,
  });
  if (req.sessionId) await StaffLogin.updateOne({ session: req.sessionId }, { $inc: { actions: 1 } });
}

/** The middleware. */
function audit(req, res, next) {
  if (!MUTATING.has(req.method) || !req.account || !req.account._id) return next();
  const path = pathOf(req);
  if (SKIP.some((re) => re.test(path))) return next();
  const started = Date.now();
  let answer = null;
  const json = res.json;
  res.json = function captured(body) {
    answer = body;
    return json.call(this, body);
  };
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    track(record({ req, path, status: res.statusCode, answer, ms: Date.now() - started })).catch((err) => console.error("audit: the event was not written -", err.message));
  });
  return next();
}

/** Resolves when every event in flight is written (tests). */
const flush = () => Promise.allSettled([...pending]);

module.exports = { audit, flush, pathOf, SKIP };
