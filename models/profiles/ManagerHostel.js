/**
 * @file ManagerHostel profile — מנהל/ת הוסטל (כמו תמר)
 * @module models/profiles/ManagerHostel
 */

const mongoose = require("mongoose");
const { Profile } = require("../Profile");

const schema = new mongoose.Schema({
  /** The hostels this person manages — at least one. */
  hostels: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Hostel" }],
    validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: "מנהל/ת הוסטל חייב/ת לפחות הוסטל אחד" },
  },
});

schema.index({ world: 1, hostels: 1 });

module.exports = Profile.discriminator("ManagerHostel", schema);
