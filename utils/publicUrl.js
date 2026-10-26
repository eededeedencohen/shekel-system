/**
 * @file publicUrl - the full address of a public link, made on the server
 * @module utils/publicUrl
 *
 * Stage 4b of the hardening plan (2026-10-26, section 9-ב): link tokens
 * no longer ride in list payloads; the staff who need a link ask its own
 * route (`GET …/:id/link`) and get the whole address back. The origin is
 * the app's own (`PUBLIC_ORIGIN` when set, else the request's host behind
 * Render's proxy - app.js trusts it).
 */

function publicOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

/** { token, url, expiresAt, live } for a public page under `path` (which already carries the token). */
function linkAnswer(req, path, token, expiresAt = null) {
  return {
    token,
    url: `${publicOrigin(req)}${path}`,
    expiresAt: expiresAt || null,
    live: !expiresAt || new Date(expiresAt).getTime() > Date.now(),
  };
}

module.exports = { publicOrigin, linkAnswer };
