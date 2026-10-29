/**
 * @file userAgent - a browser's user-agent string in a few words
 * @module utils/userAgent
 *
 * The sign-ins page says "Chrome · Windows" or "Safari · iPhone" instead of
 * the raw string. Good enough for the handful of browsers the staff use; an
 * unknown string answers with empty words, never throws.
 */

function browserOf(ua) {
  if (/HeadlessChrome/i.test(ua)) return "Headless Chrome";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/CriOS/.test(ua)) return "Chrome";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  if (/Safari\//.test(ua)) return "Safari";
  return "";
}

function osOf(ua) {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

/** `{ browser, os, mobile }` for a user-agent string. */
function describeUserAgent(ua) {
  const s = String(ua || "");
  return { browser: browserOf(s), os: osOf(s), mobile: /Mobi|Android|iPhone|iPad/i.test(s) };
}

module.exports = { describeUserAgent };
