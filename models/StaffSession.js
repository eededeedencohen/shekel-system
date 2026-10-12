/**
 * @file StaffSession model - one signed-in browser
 * @module models/StaffSession
 *
 * The browser holds a random token in an HttpOnly cookie; this row holds
 * only its SHA-256, so a copy of the table signs nobody in. A session lives
 * 30 days from its last use (the TTL index removes it after that); a
 * password change or reset ends every session of the account.
 */

const mongoose = require("mongoose");

const staffSessionSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: Date.now },
    userAgent: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "staffSessions" }
);

staffSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("StaffSession", staffSessionSchema);
