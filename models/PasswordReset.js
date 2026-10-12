/**
 * @file PasswordReset model - a link that sets a new password
 * @module models/PasswordReset
 *
 * The super admin presses "איפוס סיסמה" on the users page: the link goes to
 * the person on WhatsApp and stays open RESET_LINK_HOURS. The token is made
 * in the browser (so the message is ready at once) and only its SHA-256 is
 * kept here. Used once; the TTL index removes the row when it expires.
 */

const mongoose = require("mongoose");

const passwordResetSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    /** Who made the link (the super admin's name). */
    createdBy: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "passwordResets" }
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PasswordReset", passwordResetSchema);
