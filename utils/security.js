/**
 * @file security - the front door's hardening: CORS, the response headers, the rate limits
 * @module utils/security
 *
 * Stage 4d of the hardening plan (2026-10-27, section 9-ד):
 *
 *   CORS       a closed list of origins with credentials instead of `*`:
 *              the app's own origin (PUBLIC_ORIGIN / APP_ORIGINS, the Render
 *              address) and, outside production, the Vite dev servers. A
 *              request without an Origin (the page itself, curl, the tests)
 *              is same-origin and passes.
 *   helmet     the standard headers, with a Content-Security-Policy made for
 *              this app: scripts from the app alone (+ the one inline theme
 *              script of index.html, by its hash), styles and fonts from
 *              Google Fonts, pictures and reads from the files bucket,
 *              blob: for the Blob cache / PDF previews / the pdf.js worker.
 *   limits     express-rate-limit on the sign-in route, on the public token
 *              routes and on the upload-url routes. Off in the tests unless
 *              RATE_LIMIT_TEST=1 (security.test.js).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const PRODUCTION = process.env.NODE_ENV === "production";
const DEV_ORIGINS = ["http://localhost:5173", "http://localhost:5174", "https://localhost:5173", "https://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"];
const RENDER_ORIGIN = "https://shekel-system.onrender.com";

/** The origins a browser may call the API from, with the session cookie. */
function allowedOrigins() {
  const listed = String(process.env.APP_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (process.env.PUBLIC_ORIGIN) listed.push(process.env.PUBLIC_ORIGIN.replace(/\/$/, ""));
  listed.push(RENDER_ORIGIN);
  if (!PRODUCTION) listed.push(...DEV_ORIGINS);
  return new Set(listed);
}

const corsOptions = () => {
  const allowed = allowedOrigins();
  return {
    // no Origin = the page itself / a tool: fine; a listed origin: fine with the cookie; anyone else gets no CORS headers
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Acting-As"],
    maxAge: 600,
  };
};

/** The sha256 of index.html's inline theme script (the one script that is not a file), for the CSP. */
function inlineScriptHashes(indexHtml) {
  try {
    const html = fs.readFileSync(indexHtml, "utf8");
    const out = [];
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      out.push(`'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
    }
    return out;
  } catch {
    return [];
  }
}

/** The bucket's host for the CSP (pictures by plain link, reads by fetch). */
function bucketHosts() {
  const name = process.env.AWS_S3_BUCKET_NAME;
  const region = process.env.AWS_REGION;
  const hosts = ["https://*.amazonaws.com"];
  if (name && region) hosts.push(`https://${name}.s3.${region}.amazonaws.com`);
  return hosts;
}

function securityHeaders({ indexHtml } = {}) {
  const hashes = indexHtml ? inlineScriptHashes(indexHtml) : [];
  const bucket = bucketHosts();
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'self'"],
        "form-action": ["'self'"],
        "script-src": ["'self'", ...hashes],
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:", ...bucket],
        "media-src": ["'self'", "data:", "blob:"],
        // data: and blob: too - the client turns a thumbnail's data URL into a Blob with fetch, and the PDF builders read blob: URLs
        "connect-src": ["'self'", "data:", "blob:", ...bucket],
        "frame-src": ["'self'", "blob:"],
        "manifest-src": ["'self'"],
        "upgrade-insecure-requests": PRODUCTION ? [] : null,
      },
    },
    // the file viewer opens blob: pages and the WhatsApp buttons open wa.me in a new tab: both fine under these
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: PRODUCTION ? { maxAge: 180 * 24 * 3600, includeSubDomains: false } : false,
  });
}

/* ───────────────────────── rate limits ───────────────────────── */

const MINUTES = 60 * 1000;
const skipInTests = () => process.env.NODE_ENV === "test" && process.env.RATE_LIMIT_TEST !== "1";
const limiter = (limit, windowMs, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: skipInTests,
    handler: (req, res) => res.status(429).json({ status: "fail", code: "TOO_MANY_REQUESTS", message }),
  });

/** Sign-in: 20 tries per address per 15 minutes (the lockout per name is authService's own). */
const loginLimiter = limiter(Number(process.env.RATE_LIMIT_LOGIN || 20), 15 * MINUTES, "יותר מדי ניסיונות כניסה - אפשר לנסות שוב בעוד כמה דקות");
/** The public token pages: a generous budget per address (a phone fills a form and uploads a few files). */
const publicLimiter = limiter(Number(process.env.RATE_LIMIT_PUBLIC || 600), 15 * MINUTES, "יותר מדי בקשות מהכתובת הזו - אפשר לנסות שוב בעוד כמה דקות");
/** Upload beginnings: 120 per address per 15 minutes (every one is a pending object in the bucket). */
const uploadLimiter = limiter(Number(process.env.RATE_LIMIT_UPLOAD || 120), 15 * MINUTES, "יותר מדי העלאות בבת אחת - אפשר לנסות שוב בעוד כמה דקות");

module.exports = { allowedOrigins, corsOptions, securityHeaders, inlineScriptHashes, loginLimiter, publicLimiter, uploadLimiter };
