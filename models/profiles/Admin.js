/**
 * @file Admin profile — מנהל/ת מערכת (סופר-אדמין)
 * @module models/profiles/Admin
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

module.exports = Profile.discriminator("Admin", new mongoose.Schema({}));
