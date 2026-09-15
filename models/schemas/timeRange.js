/**
 * @file Shared TimeRange sub-schema
 * @module models/schemas/timeRange
 *
 * THE one shape for a weekly time window — person availability and cycle
 * schedule slots both build on it, so "HH:mm" validation and start<end
 * live in exactly one place (the remodel killed the three drifted copies).
 *
 * Days are Sunday–Thursday (0–4); Fridays/Saturdays don't exist in Shekel's
 * week. Times are zero-padded "HH:mm", which makes lexicographic comparison
 * safe for the start<end check.
 */

const mongoose = require("mongoose");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Build a TimeRange schema, optionally extended with extra paths
 * (e.g. the schedule slot adds a `room` ref).
 *
 * @param {object} [extraPaths]  Additional schema paths.
 * @returns {mongoose.Schema}
 */
function timeRangeSchema(extraPaths = {}) {
  const schema = new mongoose.Schema({
    day: {
      type: Number,
      min: 0,
      max: [4, "אין פעילות בימי שישי/שבת"],
      required: [true, "חובה לציין יום"],
    },
    start: {
      type: String,
      required: [true, "חובה לציין שעת התחלה"],
      match: [TIME_RE, "שעת התחלה חייבת להיות בפורמט HH:mm"],
    },
    end: {
      type: String,
      required: [true, "חובה לציין שעת סיום"],
      match: [TIME_RE, "שעת סיום חייבת להיות בפורמט HH:mm"],
    },
    ...extraPaths,
  });

  schema.pre("validate", function (next) {
    if (this.start && this.end && this.end <= this.start) {
      this.invalidate("end", "שעת הסיום חייבת להיות אחרי שעת ההתחלה");
    }
    next();
  });

  return schema;
}

module.exports = { timeRangeSchema, TIME_RE };
