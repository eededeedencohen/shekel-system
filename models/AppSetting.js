/**
 * @file AppSetting model - a setting of the whole app, one row per key
 * @module models/AppSetting
 *
 * Not a person's preference (those live on the account - StaffAccount
 * `diaryDesign`): a choice that is the same for everyone who opens the app.
 * Today one key, "look" (services/appLookService): which opening animation
 * plays and how the pages' headers are drawn - the super admin chooses, and
 * it holds for all (Eden, 2026-11-19: "ההגדרות של ההנפשות ושל הכותרות יהיו
 * רק לעדן הסופר מנהל ומה שהוא יבחר זה ישפיע לכולם").
 *
 * One small single-concern table: a key, its value, who set it.
 */

const mongoose = require("mongoose");

const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AppSetting", appSettingSchema);
