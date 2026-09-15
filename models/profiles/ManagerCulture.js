/**
 * @file ManagerCulture profile — צוות תרבות לכל (מנהל/ת, רכז/ת, עובד/ת)
 * @module models/profiles/ManagerCulture
 *
 * The ERD's "מנהל/עובדי תרבות לכל": the only people who may create and
 * publish culture events, act on other students' registrations, report
 * attendance and hand out vouchers. services/cultureService checks for an
 * ACTIVE profile of this kind on every such write.
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** Free-text role title — "מנהלת", "רכז תרבות", "מתנדב". */
  title: { type: String, trim: true },
});

module.exports = Profile.discriminator("ManagerCulture", schema);
