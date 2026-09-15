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

const AppError = require("./utils/AppError");
const globalErrorHandler = require("./controllers/errorController");
const { WORLDS } = require("./utils/domain");

const app = express();

// Global middleware
app.use(cors());
app.use(express.json());

// World scoping (the demo-data switch): the client sends `X-Dataset`
// ("real" | "pokemon" | "test"); anything else means the real world.
// EVERY query is filtered by req.world and every create is stamped with it
// server-side — `world` is never accepted from a request body (stripped
// here so no handler has to remember).
app.use((req, res, next) => {
  // `?world=` is the header's stand-in for plain links the browser opens
  // without custom headers (a stored document in a new tab).
  const w = req.get("x-dataset") || (req.method === "GET" ? req.query.world : undefined);
  req.world = WORLDS.includes(w) ? w : "real";
  if (req.body && typeof req.body === "object" && "world" in req.body) {
    delete req.body.world;
  }
  next();
});

// Request logging — colourised "dev" format. Enabled only in development;
// kept off for production (use combined+file there) and tests (keeps Jest
// output readable).
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// Health check (under /api — "/" belongs to the client app when its build
// is present, see the end of this file).
const health = (req, res) => {
  res.status(200).json({ status: "success", message: "Shekel API is running" });
};
app.get("/api/health", health);

// Feature routers — the 2026 remodel API
app.use("/api/people", require("./routes/personRoutes"));
app.use("/api/profiles", require("./routes/profileRoutes"));
app.use("/api/subjects", require("./routes/subjectRoutes"));
app.use("/api/cycles", require("./routes/cycleRoutes"));
app.use("/api/enrollments", require("./routes/enrollmentRoutes"));
app.use("/api/lessons", require("./routes/lessonRoutes"));
app.use("/api/rooms", require("./routes/roomRoutes"));
app.use("/api/hostels", require("./routes/hostelRoutes"));
// תרבות לכל — events, registrations (seats + waitlist + attendance), vouchers
app.use("/api/events", require("./routes/eventRoutes"));
app.use("/api/event-registrations", require("./routes/registrationRoutes"));
app.use("/api/vouchers", require("./routes/voucherRoutes"));
// קליטה (אינטייק) — the social worker's records, and the public sign-up
// page that feeds them (no login; see controllers/publicController).
app.use("/api/intakes", require("./routes/intakeRoutes"));
app.use("/api/public", require("./routes/publicRoutes"));
// הספרייה — books (scanned in, details from booknet / Google Books) and
// their loans: one copy per book, return days skip Fri/Shabbat.
app.use("/api/library", require("./routes/libraryRoutes"));
app.use("/api/meta", require("./routes/metaRoutes"));
// Read-only DB explorer (schema introspection + raw browsing) — powers the
// in-app "בסיס הנתונים" page. Note: /schema is matched before /:collection.
app.use("/api/db", require("./routes/dbRoutes"));

// ── The client, served by this same process ──────────────────────────────
// `client-dist/` is the React build that `npm run deploy` (in client/) drops
// here. When it exists, this server IS the whole app: hashed assets are
// cached for a year, index.html never, and every non-/api GET falls back to
// index.html so React Router owns the URL (/students/…, /join, …). Without
// a build (a bare API checkout) "/" answers the health check instead.
const CLIENT_DIST = path.join(__dirname, "client-dist");
if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      maxAge: "1y",
      immutable: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, "index.html"), { headers: { "Cache-Control": "no-cache" } });
  });
} else {
  app.get("/", health);
}

// Unmatched routes — must come after all real routes
app.all(/.*/, (req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server`, 404));
});

// Centralised error handler — must be last
app.use(globalErrorHandler);

module.exports = app;
