/**
 * @file Room model — a physical campus room the scheduler cannot bypass
 * @module models/Room
 *
 * Every room mention in the system is an ObjectId ref to this collection
 * (cycles.schedule[].room, cycles.matching.requiredRooms[], lessons.room)
 * and the name is unique per world — the free-string room era is over.
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const roomSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    name: { type: String, required: [true, "שם חדר הוא חובה"], trim: true },
    /** OPTIONAL — imported rooms have no known capacity; we don't invent one. */
    capacity: {
      type: Number,
      min: [1, "תפוסת החדר חייבת להיות לפחות אדם אחד"],
    },
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

roomSchema.index({ world: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Room", roomSchema);
