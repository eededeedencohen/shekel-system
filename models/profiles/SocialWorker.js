/**
 * @file SocialWorker profile — עובד/ת סוציאלי/ת (ייטב)
 * @module models/profiles/SocialWorker
 *
 * The role that runs the intake: calls every new lead, sets the intake
 * meeting, signs the confidentiality waiver and collects the documents
 * (services/intakeService). Until auth exists the intake actions carry
 * the persona's name as a string, like the rest of the pipeline; this
 * profile is where the permission check will hang once there is a login.
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** Free-text role title — "עו\"ס", "עו\"ס קליטה". */
  title: { type: String, trim: true },
  /** Which programs' leads land on this worker's board (empty = both). */
  programs: [{ type: String, trim: true }],
});

module.exports = Profile.discriminator("SocialWorker", schema);
