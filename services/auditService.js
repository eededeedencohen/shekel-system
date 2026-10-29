/**
 * @file auditService - the activity pages' reads: who is in, who signed in when, who did what
 * @module services/auditService
 *
 * Super admin only (routes/auditRoutes). Three tables feed it: the accounts
 * (StaffAccount), the sign-ins (StaffLogin, one per session from first to
 * last minute) and the writes (AuditEvent, one per successful mutation).
 * A sign-in with no end but not seen for SESSION_DAYS is shown - and
 * written - as expired (the live key died with the TTL index anyway).
 */

const mongoose = require("mongoose");
const StaffAccount = require("../models/StaffAccount");
const StaffLogin = require("../models/StaffLogin");
const AuditEvent = require("../models/AuditEvent");
const presence = require("./presenceService");
const AppError = require("../utils/AppError");

const DAY = 86400000;
const SESSION_DAYS = 30; // = authService SESSION_DAYS: a sign-in lives this long after its last use
const MONTH_MS = 30 * DAY;

const isId = (v) => mongoose.isValidObjectId(String(v || ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const accountView = (a) =>
  a
    ? { _id: String(a._id), username: a.username, name: a.name, title: a.title || "", kind: a.kind, active: a.active !== false, lastLoginAt: a.lastLoginAt || null, createdAt: a.createdAt }
    : null;

/** Open sign-ins not seen for a month are over: written as expired, once. */
async function sweepExpired(now = Date.now()) {
  await StaffLogin.updateMany({ endedAt: null, lastSeenAt: { $lt: new Date(now - SESSION_DAYS * DAY) } }, [
    { $set: { endedAt: { $add: ["$lastSeenAt", SESSION_DAYS * DAY] }, endReason: "expired" } },
  ]);
}

/** One sign-in as the page reads it: when it began, when it was last seen, how and when it ended, or how long it still lives. */
function loginView(r, now = Date.now()) {
  const lastSeen = new Date(r.lastSeenAt).getTime();
  const expiresAt = new Date(lastSeen + SESSION_DAYS * DAY);
  let endedAt = r.endedAt || null;
  let endReason = r.endReason || null;
  let live = false;
  if (!endedAt) {
    if (expiresAt.getTime() <= now) {
      endedAt = expiresAt;
      endReason = "expired";
    } else live = true;
  }
  // the browser said goodbye after it was last seen: the window is closed, the key still lives
  const closed = live && presence.isGone(r.lastSeenAt, r.leftAt);
  return {
    _id: String(r._id),
    session: String(r.session),
    account: r.account && typeof r.account === "object" ? accountView(r.account) : { _id: String(r.account) },
    how: r.how || "password",
    startedAt: r.startedAt,
    lastSeenAt: r.lastSeenAt,
    endedAt,
    endReason,
    live,
    state: !live ? "ended" : closed ? "closed" : presence.stateOf(r.lastSeenAt, now),
    leftAt: closed ? r.leftAt : null,
    expiresAt: live ? expiresAt : null,
    ip: r.ip || "",
    device: r.device || {},
    userAgent: r.userAgent || "",
    actions: r.actions || 0,
  };
}

/**
 * The sign-ins, newest first - all of them or one account's; `before` (a
 * startedAt) pages, `limit` caps (default 50, at most 200).
 */
async function logins({ account, before, limit } = {}) {
  const now = Date.now();
  await sweepExpired(now);
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const filter = {};
  if (account) {
    if (!isId(account)) throw AppError.of("NOT_FOUND", 404, "משתמש");
    filter.account = oid(account);
  }
  if (before && !Number.isNaN(Date.parse(before))) filter.startedAt = { $lt: new Date(before) };
  const rows = await StaffLogin.find(filter).sort({ startedAt: -1 }).limit(n + 1).populate("account", "username name title kind active lastLoginAt createdAt").lean();
  return { logins: rows.slice(0, n).map((r) => loginView(r, now)), hasMore: rows.length > n, now: new Date(now) };
}

const eventView = (e) => ({
  _id: String(e._id),
  at: e.at,
  account: String(e.account),
  accountName: e.accountName,
  actor: String(e.actor),
  actorName: e.actorName,
  actorKind: e.actorKind,
  /** The super admin did it while viewing as someone else. */
  borrowed: String(e.account) !== String(e.actor),
  method: e.method,
  path: e.path,
  route: e.route,
  status: e.status,
  verb: e.verb,
  title: e.title,
  kind: e.kind,
  target: e.target || { id: null, label: "" },
  payload: e.payload ?? null,
  summary: e.summary || "",
  facts: e.facts || [],
  changes: e.changes || [],
  ip: e.ip || "",
  ms: e.ms || 0,
});

/**
 * "ניקוי היסטוריית הפעילות" (Eden, 2026-10-29): the super admin empties the
 * writes and / or the ENDED sign-ins - of everyone or of one account,
 * everything or only what is older than `olderThanDays`. Live sign-ins
 * stay (they are the presence). The clearing itself is a write, so the
 * audit middleware records it with the counts.
 */
async function clear({ what, user, olderThanDays } = {}) {
  const wanted = new Set(Array.isArray(what) ? what : what ? [what] : ["events"]);
  const days = Math.max(0, parseInt(olderThanDays, 10) || 0);
  const cutoff = days ? new Date(Date.now() - days * DAY) : null;
  if (user && !isId(user)) throw AppError.of("NOT_FOUND", 404, "משתמש");
  const who = user ? oid(user) : null;
  const out = { events: 0, logins: 0 };
  if (wanted.has("events")) {
    const filter = {};
    if (who) filter.$or = [{ actor: who }, { account: who }];
    if (cutoff) filter.at = { $lt: cutoff };
    out.events = (await AuditEvent.deleteMany(filter)).deletedCount || 0;
  }
  if (wanted.has("logins")) {
    await sweepExpired();
    const filter = { endedAt: { $ne: null } };
    if (who) filter.account = who;
    if (cutoff) filter.startedAt = { $lt: cutoff };
    out.logins = (await StaffLogin.deleteMany(filter)).deletedCount || 0;
  }
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The writes, newest first. `user` = done by or in the name of that account
 * (the viewing-as case counts on both pages); `verb`, `kind`, `q` (title /
 * target / path), `from` / `to` (dates), `before` (an `at`) page.
 */
async function events({ user, account, actor, verb, kind, q, from, to, before, limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 300);
  const and = [];
  if (user) {
    if (!isId(user)) throw AppError.of("NOT_FOUND", 404, "משתמש");
    and.push({ $or: [{ actor: oid(user) }, { account: oid(user) }] });
  }
  if (account && isId(account)) and.push({ account: oid(account) });
  if (actor && isId(actor)) and.push({ actor: oid(actor) });
  if (verb && AuditEvent.VERBS.includes(verb)) and.push({ verb });
  if (kind) and.push({ kind: String(kind) });
  if (q && String(q).trim()) {
    const re = new RegExp(escapeRe(String(q).trim()), "i");
    and.push({ $or: [{ title: re }, { "target.label": re }, { path: re }, { actorName: re }] });
  }
  const at = {};
  if (from && !Number.isNaN(Date.parse(from))) at.$gte = new Date(from);
  if (to && !Number.isNaN(Date.parse(to))) at.$lte = new Date(to);
  if (before && !Number.isNaN(Date.parse(before))) at.$lt = new Date(before);
  if (Object.keys(at).length) and.push({ at });
  const filter = and.length ? { $and: and } : {};
  const rows = await AuditEvent.find(filter).sort({ at: -1, _id: -1 }).limit(n + 1).lean();
  return { events: rows.slice(0, n).map(eventView), hasMore: rows.length > n };
}

/**
 * The activity page's first screen: who is online now, and every account
 * with its sign-ins and its writes summed up (the last 30 days of writes).
 */
async function overview() {
  const now = Date.now();
  await sweepExpired(now);
  const [accounts, online, loginAgg, eventAgg, borrowedAgg] = await Promise.all([
    StaffAccount.find().sort({ createdAt: 1 }).lean(),
    presence.online(now),
    StaffLogin.aggregate([
      {
        $group: {
          _id: "$account",
          logins: { $sum: 1 },
          lastStartedAt: { $max: "$startedAt" },
          lastSeenAt: { $max: "$lastSeenAt" },
          open: { $sum: { $cond: [{ $eq: ["$endedAt", null] }, 1, 0] } },
          actions: { $sum: "$actions" },
        },
      },
    ]),
    AuditEvent.aggregate([{ $match: { at: { $gte: new Date(now - MONTH_MS) } } }, { $group: { _id: "$actor", actions30d: { $sum: 1 }, lastActionAt: { $max: "$at" } } }]),
    // what the super admin did in someone else's name, counted on the super admin too
    AuditEvent.aggregate([
      { $match: { at: { $gte: new Date(now - MONTH_MS) }, $expr: { $ne: ["$account", "$actor"] } } },
      { $group: { _id: "$account", borrowed30d: { $sum: 1 } } },
    ]),
  ]);
  const logins = new Map(loginAgg.map((r) => [String(r._id), r]));
  const acts = new Map(eventAgg.map((r) => [String(r._id), r]));
  const borrowed = new Map(borrowedAgg.map((r) => [String(r._id), r]));
  const onlineByAccount = new Map();
  for (const o of online) {
    const key = o.account._id;
    const prev = onlineByAccount.get(key);
    if (!prev || new Date(o.lastSeenAt) > new Date(prev.lastSeenAt)) onlineByAccount.set(key, o);
  }
  const rows = accounts.map((a) => {
    const id = String(a._id);
    const l = logins.get(id);
    const e = acts.get(id);
    const b = borrowed.get(id);
    const o = onlineByAccount.get(id);
    return {
      ...accountView(a),
      state: o ? o.state : "offline",
      lastSeenAt: o ? o.lastSeenAt : l ? l.lastSeenAt : null,
      lastStartedAt: l ? l.lastStartedAt : null,
      logins: l ? l.logins : 0,
      openLogins: l ? l.open : 0,
      actions30d: e ? e.actions30d : 0,
      borrowed30d: b ? b.borrowed30d : 0,
      lastActionAt: e ? e.lastActionAt : null,
      sessions: online.filter((x) => x.account._id === id).length,
    };
  });
  return { now: new Date(now), online, accounts: rows };
}

/** One account's page header: the account, its writes by verb, its sign-ins in numbers, its presence. */
async function userSummary(id) {
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "משתמש");
  const account = await StaffAccount.findById(id).lean();
  if (!account) throw AppError.of("NOT_FOUND", 404, "משתמש");
  const now = Date.now();
  await sweepExpired(now);
  const who = oid(id);
  const [byVerb, firstLast, loginAgg, online] = await Promise.all([
    AuditEvent.aggregate([{ $match: { $or: [{ actor: who }, { account: who }] } }, { $group: { _id: "$verb", n: { $sum: 1 } } }]),
    AuditEvent.aggregate([{ $match: { $or: [{ actor: who }, { account: who }] } }, { $group: { _id: null, first: { $min: "$at" }, last: { $max: "$at" }, total: { $sum: 1 } } }]),
    StaffLogin.aggregate([{ $match: { account: who } }, { $group: { _id: null, logins: { $sum: 1 }, first: { $min: "$startedAt" }, last: { $max: "$startedAt" }, lastSeenAt: { $max: "$lastSeenAt" }, open: { $sum: { $cond: [{ $eq: ["$endedAt", null] }, 1, 0] } } } }]),
    presence.online(now),
  ]);
  const verbs = Object.fromEntries(AuditEvent.VERBS.map((v) => [v, 0]));
  for (const r of byVerb) verbs[r._id] = r.n;
  const fl = firstLast[0] || { first: null, last: null, total: 0 };
  const lg = loginAgg[0] || { logins: 0, first: null, last: null, lastSeenAt: null, open: 0 };
  const mine = online.filter((o) => o.account._id === String(id));
  return {
    account: accountView(account),
    actions: { total: fl.total, ...verbs, firstAt: fl.first, lastAt: fl.last },
    logins: { total: lg.logins, firstAt: lg.first, lastAt: lg.last, lastSeenAt: mine[0]?.lastSeenAt || lg.lastSeenAt, open: lg.open },
    state: mine[0]?.state || "offline",
    online: mine,
    now: new Date(now),
  };
}

module.exports = { logins, events, overview, userSummary, clear, loginView, eventView, sweepExpired, SESSION_DAYS };
