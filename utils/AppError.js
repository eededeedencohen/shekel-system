/**
 * @file AppError — typed operational error
 * @module utils/AppError
 *
 * Distinguishes *operational* errors (predictable failures we throw on
 * purpose, e.g. 404, 400 validation) from *programmer* errors (bugs,
 * unexpected exceptions). The global error handler relies on the
 * `isOperational` flag to decide whether to surface details to the client.
 */

class AppError extends Error {
  /**
   * @param {string} message  - Human-readable error message.
   * @param {number} statusCode - HTTP status code (4xx → fail, 5xx → error).
   * @param {string} [code]   - Stable English error code (see domain.ERROR_CODES).
   */
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = true;
    if (code) this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Error policy: stable English code + the Hebrew label from domain.js.
   * `AppError.of("CYCLE_FULL", 409)` → message "אין מקום פנוי במחזור",
   * code "CYCLE_FULL" in the response envelope.
   */
  static of(code, statusCode = 400, detail) {
    // Lazy require avoids a cycle (domain has no deps, but stay safe).
    const { ERROR_CODES } = require("./domain");
    const label = ERROR_CODES[code] || code;
    return new AppError(detail ? `${label}: ${detail}` : label, statusCode, code);
  }
}

module.exports = AppError;
