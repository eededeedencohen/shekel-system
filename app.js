/**
 * @file Express application setup
 * @module app
 *
 * Wires global middleware, mounts feature routers under /api, and installs
 * the global error-handling stack:
 *   1. Catch-all 404 for unknown routes (creates an AppError).
 *   2. Centralised error middleware (controllers/errorController) that
 *      shapes every error response into the standard envelope.
 *
 * The process lifecycle (env loading, DB connection, HTTP listen)
 * lives in server.js.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const compression = require("compression");

const AppError = require("./utils/AppError");
const globalErrorHandler = require("./controllers/errorController");
const share = require("./utils/sharePreview");
const { authenticate, requireSuper, requireFamily } = require("./utils/auth");

const app = express();
// Render sits in front of us: req.secure / req.ip come from its headers
// (the session cookie is marked Secure on https).
app.set("trust proxy", 1);

// Global middleware. ONE body limit for the whole API (a router-level
// express.json() never gets to raise it once this one refused the body -
// the "Something went wrong" of 2026-09-17). Since the S3 move (2026-10-26)
// no file travels in JSON - the browser PUTs it to the bucket - so 2MB is
// plenty: the biggest body left is a signed waiver's three PNG signatures
// (≤ 256KB each, base64) plus the form.
app.use(cors());
// Every answer leaves gzipped - the JSON slices and the client bundle alike. Nothing was compressed
// before (Eden, 2026-10-25: שמרית's phone took "הרבה מאוד זמן לטעון"): her boot was ~2MB of JSON over
// the air plus a 2.4MB bundle after every deploy; repeated shapes squeeze five to eight times.
app.use(compression());
app.use(express.json({ limit: "2mb" }));

// Request logging - colourised "dev" format. Enabled only in development;
// kept off for production (use combined+file there) and tests (keeps Jest
// output readable).
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// Health check (under /api - "/" belongs to the client app when its build
// is present, see the end of this file).
const health = (req, res) => {
  res.status(200).json({ status: "success", message: "Shekel API is running" });
};
app.get("/api/health", health);

// Passwords (Eden, 2026-10-12): every /api route needs a signed-in staff
// member, except the public sign-up pages and the sign-in routes
// themselves (utils/auth OPEN). req.account = who is signed in.
app.use("/api", authenticate);
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/accounts", require("./routes/accountRoutes"));

// Feature routers - the 2026 remodel API. A family's router is open only to
// the kinds that own it (utils/auth requireFamily, Eden 2026-10-18): the
// ACTING persona loads and reads its own data, nothing of another program's.
app.use("/api/people", require("./routes/personRoutes"));
app.use("/api/profiles", require("./routes/profileRoutes"));
// the files bucket (2026-10-26): signed uploads and reads; the family and
// the lens decide per file inside (services/fileService, fileAccess)
app.use("/api/files", require("./routes/fileRoutes"));
app.use("/api/subjects", requireFamily("college"), require("./routes/subjectRoutes"));
app.use("/api/subject-categories", requireFamily("college"), require("./routes/subjectCategoryRoutes"));
app.use("/api/cycles", requireFamily("college"), require("./routes/cycleRoutes"));
app.use("/api/enrollments", requireFamily("college"), require("./routes/enrollmentRoutes"));
app.use("/api/lessons", requireFamily("college"), require("./routes/lessonRoutes"));
app.use("/api/rooms", requireFamily("college"), require("./routes/roomRoutes"));
app.use("/api/hostels", requireFamily("hostels"), require("./routes/hostelRoutes"));
// the houses' attendance drafts (phase 3 of שמרית's round): a temporary link
// per hostel per month; the house's side is under /api/public/hostel-reports.
app.use("/api/hostel-reports", requireFamily("hostels"), require("./routes/hostelReportRoutes"));
// תרבות לכל - events, registrations (seats + waitlist + attendance), vouchers
app.use("/api/events", requireFamily("culture"), require("./routes/eventRoutes"));
app.use("/api/event-registrations", requireFamily("culture"), require("./routes/registrationRoutes"));
app.use("/api/vouchers", requireFamily("culture"), require("./routes/voucherRoutes"));
// קליטה (אינטייק) - the social worker's records, and the public sign-up
// page that feeds them (no login; see controllers/publicController).
app.use("/api/intakes", require("./routes/intakeRoutes"));
app.use("/api/public", require("./routes/publicRoutes"));
// פתיחת תיק ספק (Eden, 2026-10-14) - the hostels coordinator's suppliers;
// the supplier's own side is under /api/public/supplier/:token.
app.use("/api/suppliers", require("./routes/supplierRoutes"));
// לשונית פעילויות + אירועים חריגים (the social worker's round, 2026-10-07):
// a person's record with editable templates, and incident reports.
app.use("/api/activities", require("./routes/activityRoutes"));
app.use("/api/incidents", require("./routes/incidentRoutes"));
// הספרייה - books (scanned in, details from booknet / Google Books) and
// their loans: one copy per book, return days skip Fri/Shabbat.
app.use("/api/library", requireFamily("library"), require("./routes/libraryRoutes"));
// חשבוניות של מורים - a picture + the lessons written on it (three small
// tables: files, invoices, invoiceLessons; the first of the 2026-10 remodel).
app.use("/api/invoices", requireFamily("invoices"), require("./routes/invoiceRoutes"));
// the monthly invoice round (שמרית's round, 2026-10-19): a temporary link
// per teacher per month; the teacher's side is under /api/public/invoices.
app.use("/api/invoice-rounds", requireFamily("invoices"), require("./routes/invoiceRoundRoutes"));
// יומן - every staff member's own notes and tasks
app.use("/api/diary", require("./routes/diaryRoutes"));
// תגיות - what a person or a cycle belongs to (roles, programs)
app.use("/api/tags", require("./routes/tagRoutes"));
app.use("/api/meta", require("./routes/metaRoutes"));
// Read-only DB explorer (schema introspection + raw browsing) - powers the
// in-app "בסיס הנתונים" page. Note: /schema is matched before /:collection.
app.use("/api/db", requireSuper, require("./routes/dbRoutes"));

// ── The client, served by this same process ──────────────────────────────
// `client-dist/` is the React build that `npm run deploy` (in client/) drops
// here. When it exists, this server IS the whole app: hashed assets are
// cached for a year, index.html never, and every non-/api GET falls back to
// index.html so React Router owns the URL (/students/…, /join, …). Without
// a build (a bare API checkout) "/" answers the health check instead.
//
// The fallback is not a plain file send: each URL gets its own share
// preview (<title> + Open Graph + the section image) stamped into the HTML
// - WhatsApp reads the page without running JavaScript, so this is the
// only place a per-page preview can come from (utils/sharePreview.js).
const CLIENT_DIST = path.join(__dirname, "client-dist");
const INDEX_HTML = path.join(CLIENT_DIST, "index.html");
if (fs.existsSync(INDEX_HTML)) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      maxAge: "1y",
      immutable: true,
      setHeaders(res, filePath) {
        // The page, the service worker, the manifest and the build stamp must always be fresh.
        if (/\.(html|webmanifest)$/.test(filePath) || filePath.endsWith("sw.js") || filePath.endsWith("version.json")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    })
  );
  let indexHtml = null; // read once, after the first request (the build may be redeployed under a running dev server)
  app.get(/^(?!\/api(?:\/|$)).*/, async (req, res, next) => {
    try {
      if (indexHtml === null || process.env.NODE_ENV === "development") indexHtml = fs.readFileSync(INDEX_HTML, "utf8");
      const preview = await share.enrich(share.previewFor(req.path, req.query));
      res.set("Cache-Control", "no-cache");
      res.type("html").send(share.injectPreview(indexHtml, preview, share.requestUrls(req)));
    } catch (err) {
      next(err);
    }
  });
} else {
  app.get("/", health);
}

// Unmatched routes - must come after all real routes
app.all(/.*/, (req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server`, 404));
});

// Centralised error handler - must be last
app.use(globalErrorHandler);

module.exports = app;
