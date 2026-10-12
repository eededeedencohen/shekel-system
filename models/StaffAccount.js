/**
 * @file StaffAccount model - a staff member who signs in
 * @module models/StaffAccount
 *
 * Eden (2026-10-12): "מעכשיו שיהיה סיסמאות למשתמשים". One row per person on
 * the staff; `kind` is what the app shows them (the client's PersonaContext
 * lens - super / manager / social / hostels / culture). Accounts are not
 * per world: one sign-in, then the topbar picks the data world.
 *
 * NOT the `users` collection - that one belongs to Eden's other projects on
 * the same Atlas database and is never touched.
 *
 * `passwordHash` never leaves the server (select: false + stripped from
 * JSON). `passwordChangedAt` empty = the account still has its default
 * password (the users page says so).
 */

const mongoose = require("mongoose");
const { STAFF_KIND_KEYS } = require("../utils/domain");

const staffAccountSchema = new mongoose.Schema(
  {
    /** The English sign-in name: lower case, letters/digits/._- (e.g. "eden"). */
    username: { type: String, required: true, trim: true, lowercase: true, unique: true, match: /^[a-z][a-z0-9._-]{1,31}$/ },
    /** The name the app shows and signs actions with ("חגי", "שירן דרעי"). */
    name: { type: String, required: true, trim: true },
    /** The role line under the name ("מנהל מכללה", 'עו"ס'). */
    title: { type: String, trim: true, default: "" },
    kind: { type: String, enum: STAFF_KIND_KEYS, required: true },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    active: { type: Boolean, default: true },
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    /** "שכחתי סיסמה" on the sign-in page - shown to the super admin until a new password is set. */
    resetRequestedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "staffAccounts",
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

module.exports = mongoose.model("StaffAccount", staffAccountSchema);
