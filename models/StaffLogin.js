/**
 * @file StaffLogin model - one sign-in, from its first minute to its last
 * @module models/StaffLogin
 *
 * Eden (2026-10-29): "שאוכל לראות מי התחבר ומתי עד מתי". StaffSession is the
 * LIVE key the browser holds (and the TTL index removes it when it dies);
 * this row is the memory of it - it stays after the session ends and says
 * who signed in, from which browser and address, when it was last seen, and
 * how it ended (signed out, expired, a new password, the account disabled).
 * `session` is the StaffSession id the row mirrors; `lastSeenAt` is what the
 * presence strip reads (services/presenceService touches it while the
 * browser pings); `actions` counts the writes made in it (utils/audit).
 */

const mongoose = require("mongoose");

const END_REASONS = ["logout", "expired", "password", "reset", "disabled", "revoked"];
const HOW = ["password", "reset"];

const staffLoginSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount", required: true, index: true },
    session: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    /** Signed in with the password, or through a reset link. */
    how: { type: String, enum: HOW, default: "password" },
    startedAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now },
    /** Empty while the session may still be alive; the view also reads an old `lastSeenAt` as expired. */
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: END_REASONS, default: null },
    ip: { type: String, trim: true, default: "" },
    userAgent: { type: String, trim: true, default: "" },
    /** What the user agent says in a few words (utils/userAgent). */
    device: {
      browser: { type: String, default: "" },
      os: { type: String, default: "" },
      mobile: { type: Boolean, default: false },
    },
    /** Successful writes made in this session (utils/audit increments it). */
    actions: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "staffLogins" }
);

staffLoginSchema.index({ account: 1, startedAt: -1 });
staffLoginSchema.index({ startedAt: -1 });
staffLoginSchema.index({ endedAt: 1, lastSeenAt: -1 });

module.exports = mongoose.model("StaffLogin", staffLoginSchema);
module.exports.END_REASONS = END_REASONS;
