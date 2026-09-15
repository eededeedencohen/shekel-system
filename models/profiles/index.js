/**
 * @file Profile registry — every user type, registered once
 * @module models/profiles
 *
 * Requiring this module registers ALL profile discriminators on the base
 * Profile model and exports the kind→model map. Controllers and services
 * never name a kind in code — they look it up here, so adding a user type
 * is: (1) a schema file in this folder, (2) a line in KINDS below,
 * (3) a label in utils/domain PROFILE_KINDS. Nothing else.
 */

const { Profile } = require("../Profile");

const KINDS = {
  StudentCollege: require("./StudentCollege"),
  StudentCulture: require("./StudentCulture"),
  Teacher: require("./Teacher"),
  ManagerCollege: require("./ManagerCollege"),
  ManagerCulture: require("./ManagerCulture"),
  ManagerHostel: require("./ManagerHostel"),
  SocialWorker: require("./SocialWorker"),
  Admin: require("./Admin"),
};

/** kind → discriminator model. */
const MODEL_BY_KIND = KINDS;
const PROFILE_KINDS = Object.keys(KINDS);

module.exports = { Profile, MODEL_BY_KIND, PROFILE_KINDS };
