/**
 * @file presenceService - who is in the app right now
 * @module services/presenceService
 *
 * Eden (2026-10-29): "שאני אדע בזמן אמת (הסופר מנהל) מי מחובר". Every
 * authenticated request touches its session here (utils/auth), and the
 * browser pings once a minute while its tab is visible (POST /api/auth/ping)
 * - so a signed-in person who is merely reading still counts. The touch is
 * kept in memory and written to the sign-in row (StaffLogin.lastSeenAt) at
 * most every 45 seconds; `online()` reads the table and lets the memory
 * correct it, so a fresh process after a deploy still knows who was around.
 *
 *   active   seen in the last 2.5 minutes (two heartbeats)
 *   idle     seen in the last 15 minutes
 *   away     older than that - not "online" any more, the sign-in may still be alive
 */

const StaffLogin = require("../models/StaffLogin");

const ACTIVE_MS = 150 * 1000;
const IDLE_MS = 15 * 60 * 1000;
const FLUSH_MS = 45 * 1000;

const seen = new Map(); // sessionId → { accountId, at, flushedAt, leftAt }

/** This session was just used. Cheap: memory, plus one small write every FLUSH_MS (at once after a goodbye). */
function touch(sessionId, accountId) {
  if (!sessionId) return;
  const key = String(sessionId);
  const now = Date.now();
  const rec = seen.get(key);
  let wasGone = false;
  if (rec) {
    rec.at = now;
    wasGone = Boolean(rec.leftAt);
    rec.leftAt = null;
    if (!wasGone && now - rec.flushedAt < FLUSH_MS) return;
    rec.flushedAt = now;
  } else {
    // a fresh process (a deploy) may hold a goodbye in the table alone: clear it with this first touch
    wasGone = true;
    seen.set(key, { accountId: String(accountId || ""), at: now, flushedAt: now, leftAt: null });
  }
  // leftAt is cleared only when a goodbye was really pending: the goodbye request itself touches first,
  // and two unordered writes must not let the touch wipe the goodbye that follows it
  const patch = wasGone ? { lastSeenAt: new Date(now), leftAt: null } : { lastSeenAt: new Date(now) };
  // the write is remembered so a goodbye in the same breath lands AFTER it (writes are not ordered by themselves)
  seen.get(key).pending = StaffLogin.updateOne({ session: sessionId }, patch).catch(() => {});
  if (seen.size > 400) {
    for (const [k, r] of seen) if (now - r.at > IDLE_MS) seen.delete(k);
  }
}

/**
 * The browser's goodbye (Eden, 2026-10-29: a closed window must not read
 * as "idle" for a quarter of an hour): the tab closed, so this session is
 * off the list until it is touched again. A phone that only goes to the
 * background sends nothing - it stays "idle" until it comes back or fades.
 */
function bye(sessionId) {
  if (!sessionId) return Promise.resolve();
  const key = String(sessionId);
  const now = Date.now();
  const rec = seen.get(key) || { accountId: "", at: now, flushedAt: now, leftAt: null, pending: null };
  rec.leftAt = now;
  seen.set(key, rec);
  // after the touch this very request made (authenticate), so the goodbye is the last word in the table
  const after = rec.pending || Promise.resolve();
  rec.pending = after.then(() => StaffLogin.updateOne({ session: sessionId }, { leftAt: new Date(now) })).catch(() => {});
  return rec.pending;
}

/** The session ended (sign-out, a new password): nothing to show for it. */
function forget(sessionId) {
  if (sessionId) seen.delete(String(sessionId));
}

/** Said goodbye after it was last seen = the window is closed. */
const isGone = (lastSeenAt, leftAt) => Boolean(leftAt) && new Date(leftAt).getTime() >= new Date(lastSeenAt).getTime() - 1000;

/** "active" / "idle" / "away" for a last-seen time. */
function stateOf(lastSeenAt, now = Date.now()) {
  const ago = now - new Date(lastSeenAt).getTime();
  if (ago <= ACTIVE_MS) return "active";
  if (ago <= IDLE_MS) return "idle";
  return "away";
}

/**
 * The open sign-ins seen in the last 15 minutes, freshest first - each with
 * its account's public fields and its `state`. Memory corrects the table's
 * `lastSeenAt` (the table lags by up to FLUSH_MS).
 */
async function online(now = Date.now()) {
  const rows = await StaffLogin.find({ endedAt: null, lastSeenAt: { $gt: new Date(now - IDLE_MS) } })
    .populate("account", "username name title kind active")
    .lean();
  for (const row of rows) {
    const rec = seen.get(String(row.session));
    if (rec) {
      if (rec.at > new Date(row.lastSeenAt).getTime()) row.lastSeenAt = new Date(rec.at);
      row.leftAt = rec.leftAt ? new Date(rec.leftAt) : null;
    }
  }
  return rows
    .filter((r) => r.account && r.account.active !== false && !isGone(r.lastSeenAt, r.leftAt))
    .map((r) => ({
      login: String(r._id),
      session: String(r.session),
      account: { _id: String(r.account._id), username: r.account.username, name: r.account.name, title: r.account.title || "", kind: r.account.kind },
      startedAt: r.startedAt,
      lastSeenAt: r.lastSeenAt,
      state: stateOf(r.lastSeenAt, now),
      device: r.device || {},
      ip: r.ip || "",
      actions: r.actions || 0,
    }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

/** The test seam: the memory, emptied. */
function reset() {
  seen.clear();
}

module.exports = { touch, bye, forget, online, stateOf, isGone, reset, ACTIVE_MS, IDLE_MS, FLUSH_MS };
