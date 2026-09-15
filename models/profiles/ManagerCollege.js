/**
 * @file ManagerCollege profile — מנהל/ת מכללה לכל
 * @module models/profiles/ManagerCollege
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

module.exports = Profile.discriminator("ManagerCollege", new mongoose.Schema({}));
