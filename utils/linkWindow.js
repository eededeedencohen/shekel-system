/**
 * Until when a temporary link stays open (Eden, 2026-11-15: "להגדיר מתי
 * שבא לי את סיום הקישור... שאני אוכל לבחור יום ולא 3 שבועות כאופציה
 * יחידה"). The coordinator names a DAY; the link then stays open through
 * the end of that day in Israel, whatever the server's own clock zone is.
 * A count of days from now is still understood (the older buttons).
 */

const AppError = require("./AppError");

const TZ = "Asia/Jerusalem";
const DAY_MS = 24 * 3600 * 1000;
/** The furthest day a link may be left open to. */
const LINK_MAX_DAYS = 366;

/** "2026-12-06" - the calendar day in Israel of a moment. */
const dayKeyIL = (d = new Date()) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });

const zoneParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** How far Israel's clock is ahead of UTC at a moment, in ms. */
function offsetAt(ms) {
  const p = Object.fromEntries(zoneParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The last millisecond of a calendar day ("YYYY-MM-DD") in Israel, or null when the text is not a real day. */
function endOfDayIL(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (new Date(wall).toISOString().slice(0, 10) !== m[0]) return null; // 2026-02-31
  // the clock's offset is asked at the answer itself (twice: the night the clock moves, the first guess stands on the other side)
  let at = wall - offsetAt(wall);
  at = wall - offsetAt(at);
  return new Date(at);
}

/**
 * The moment a link closes: through the end of `until` (a day, today at the
 * earliest and a year ahead at the latest), or `days` from now (up to 90),
 * or the link's own default.
 */
function linkExpiryFrom({ until, days } = {}, defaultDays) {
  if (until != null && until !== "") {
    const end = endOfDayIL(until);
    const today = dayKeyIL();
    if (!end || String(until) < today || end.getTime() > Date.now() + LINK_MAX_DAYS * DAY_MS) throw AppError.of("LINK_UNTIL_INVALID", 400);
    return end;
  }
  const n = Number(days) > 0 ? Math.min(Number(days), 90) : defaultDays;
  return new Date(Date.now() + n * DAY_MS);
}

module.exports = { linkExpiryFrom, endOfDayIL, dayKeyIL, LINK_MAX_DAYS };
