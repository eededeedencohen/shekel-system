/**
 * @file clientIp - the address a request really came from, for the records
 * @module utils/clientIp
 *
 * Render sits behind Cloudflare: with `trust proxy 1` Express's `req.ip` is
 * the hop before Render - Cloudflare's edge (172.69.x.x), not the person.
 * Cloudflare writes the person's address in `CF-Connecting-IP` (and
 * `True-Client-IP`); the first entry of `X-Forwarded-For` is the same
 * thing one step less trusted. This is for the sign-ins page and the audit
 * rows alone - the rate limiters keep Express's own `req.ip`.
 */

function clientIp(req) {
  const cf = req.get("cf-connecting-ip") || req.get("true-client-ip");
  if (cf) return String(cf).trim().slice(0, 60);
  const xff = String(req.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  return (xff || req.ip || "").slice(0, 60);
}

module.exports = { clientIp };
