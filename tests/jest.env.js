/**
 * @file Pre-Jest environment shim
 *
 * Runs before Jest globals are loaded. Sets NODE_ENV=test so app.js
 * suppresses request logging (morgan only registers in non-production
 * today; tests should also be quiet).
 */

process.env.NODE_ENV = "test";
