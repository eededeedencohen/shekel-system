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

const seen = new Map(); // sessionId → { accountId, at, flushedAt }

/** This session was just used. Cheap: memory, plus one small write every FLUSH_MS. */
function touch(sessionId, accountId) {
  if (!sessionId) return;
  const key = String(sessionId);
  const now = Date.now();
  const rec = seen.get(key);
  if (rec) {
    rec.at = now;
    if (now - rec.flushedAt < FLUSH_MS) return;
    rec.flushedAt = now;
  } else {
    seen.set(key, { accountId: String(accountId || ""), at: now, flushedAt: now });
  }
  StaffLogin.updateOne({ session: sessionId }, { lastSeenAt: new Date(now) }).catch(() => {});
  if (seen.size > 400) {
    for (const [k, r] of seen) if (now - r.at > IDLE_MS) seen.delete(k);
  }
}

/** The session ended (sign-out, a new password): nothing to show for it. */
function forget(sessionId) {
  if (sessionId) seen.delete(String(sessionId));
}

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
    if (rec && rec.at > new Date(row.lastSeenAt).getTime()) row.lastSeenAt = new Date(rec.at);
  }
  return rows
    .filter((r) => r.account && r.account.active !== false)
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

module.exports = { touch, forget, online, stateOf, reset, ACTIVE_MS, IDLE_MS, FLUSH_MS };
