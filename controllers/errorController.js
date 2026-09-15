/**
 * @file Global error-handling middleware
 * @module controllers/errorController
 *
 * Single source of truth for the API's error response shape. Translates
 * Mongoose-specific failures (CastError, ValidationError, duplicate keys)
 * into clean operational `AppError` instances so the client always receives
 * a uniform envelope: `{ status, message }`.
 */

const AppError = require("../utils/AppError");

/** "Cast to ObjectId failed" → 400 */
const handleCastError = (err) =>
  new AppError(`Invalid ${err.path}: ${err.value}`, 400);

/** Mongoose duplicate-key error (E11000) → 400/409 */
const handleDuplicateFields = (err) => {
  // The {cycle, student} unique index is the no-double-enroll invariant —
  // surface it as its stable domain code rather than a generic message.
  if (err.keyPattern && err.keyPattern.cycle && err.keyPattern.student) {
    return AppError.of("DUPLICATE_ENROLLMENT", 409);
  }
  if (err.keyPattern && err.keyPattern.event && err.keyPattern.student) {
    return AppError.of("DUPLICATE_REGISTRATION", 409);
  }
  if (err.keyPattern && err.keyPattern.number && err.keyPattern.world) {
    return AppError.of("VOUCHER_NUMBER_TAKEN", 409);
  }
  if (err.keyPattern && err.keyPattern.person && err.keyPattern.kind) {
    return AppError.of("PROFILE_EXISTS", 409);
  }
  // הספרייה: one copy per book / one record per barcode
  if (err.keyPattern && err.keyPattern.book && err.keyPattern.world) {
    return AppError.of("BOOK_ON_LOAN", 409);
  }
  if (err.keyPattern && err.keyPattern.barcode && err.keyPattern.world) {
    return AppError.of("BOOK_EXISTS", 409);
  }
  const value =
    (err.keyValue && Object.values(err.keyValue).join(", ")) ||
    err.errmsg ||
    "duplicate";
  return new AppError(`Duplicate field value: ${value}`, 400);
};

/** Mongoose ValidationError → 400 with combined messages */
const handleValidationError = (err) => {
  const messages = Object.values(err.errors).map((e) => e.message);
  return new AppError(`Invalid input: ${messages.join("; ")}`, 400);
};

/**
 * Express error middleware.  Note the 4-arg signature — required for
 * Express to recognise this as an error handler.
 */
module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  let mapped = err;
  if (err.name === "CastError") mapped = handleCastError(err);
  else if (err.code === 11000) mapped = handleDuplicateFields(err);
  else if (err.name === "ValidationError") mapped = handleValidationError(err);

  // Operational, trusted error: surface to client (code = stable English
  // key from domain.ERROR_CODES when the thrower used AppError.of()).
  if (mapped.isOperational) {
    return res.status(mapped.statusCode).json({
      status: mapped.status,
      message: mapped.message,
      ...(typeof mapped.code === "string" && { code: mapped.code }),
    });
  }

  // Unknown / programming error: log it, send a generic message
  console.error("💥 UNHANDLED ERROR:", err);
  return res.status(500).json({
    status: "error",
    message: "Something went wrong",
  });
};
