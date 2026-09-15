/**
 * @file Event model — a תרבות לכל outing/show/workshop (the ERD's "אירוע")
 * @module models/Event
 *
 * Lean by design, like Cycle: WHO comes lives in `eventRegistrations`
 * (seats, waitlist, attendance). What lives here is the event itself plus
 * the two staff relationships the ERD draws as diamonds — "יצר" and
 * "פירסם" — embedded as {by, at} pairs because each is 1:1 per event.
 *
 * `settings` are the ERD's הגדרות composite (gender scope, capacity, age
 * range) and are enforced by cultureService at registration time.
 *
 * Invariants:
 *  - only a `published` event accepts registrations (service).
 *  - a cancelled event cannot be re-published (service).
 *  - ageMin ≤ ageMax when both are given (validator here).
 */

const mongoose = require("mongoose");
const {
  WORLDS,
  EVENT_CATEGORY_KEYS,
  EVENT_STATUSES,
  EVENT_GENDER_SCOPES,
} = require("../utils/domain");

const stampSchema = new mongoose.Schema(
  {
    /** A person holding an ACTIVE ManagerCulture profile (service-checked). */
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    name: { type: String, required: [true, "שם האירוע הוא חובה"], trim: true },
    /** Start date+time of the event. */
    date: { type: Date, required: [true, "תאריך האירוע הוא חובה"] },
    /** Optional end time ("HH:mm") on the same day. */
    endTime: { type: String, trim: true, match: [/^([01]\d|2[0-3]):[0-5]\d$/, "שעת סיום בפורמט HH:mm"] },
    category: { type: String, enum: EVENT_CATEGORY_KEYS, default: "other" },
    location: { type: String, trim: true },
    description: { type: String, trim: true },
    /** The ERD's הגדרות: who may register + how many. */
    settings: {
      gender: { type: String, enum: EVENT_GENDER_SCOPES, default: "all" },
      capacity: { type: Number, min: [1, "קיבולת חייבת להיות לפחות 1"] },
      ageMin: { type: Number, min: 0 },
      ageMax: { type: Number, min: 0 },
    },
    status: { type: String, enum: EVENT_STATUSES, required: true, default: "draft" },
    /** Price per participant (₪). Almost always 0 in practice (senzey:
     *  "מחיר קבוע 0.00" / "לא לחיוב"); the odd show or trip is paid. */
    price: { type: Number, min: [0, "מחיר לא יכול להיות שלילי"], default: 0 },
    /** יצר — always present. */
    created: { type: stampSchema, required: true },
    /** פירסם — set when the event goes live. */
    published: { type: stampSchema, default: null },
    cancelledAt: { type: Date },
    notes: { type: String, trim: true },
    /** Senzey quarantine — every outing is a senzey "course"; the id is the
     *  idempotent re-import key, the name is the raw
     *  "סדנת אפיה - פנאי - יד חרוצים 9 - 30.8 - א` - 17:00" string. */
    import: {
      senzeyCourseId: { type: String, trim: true },
      senzeyName: { type: String, trim: true },
      billingLabel: { type: String, trim: true },
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

eventSchema.index({ world: 1, date: 1 });
eventSchema.index({ world: 1, status: 1, date: 1 });
eventSchema.index(
  { world: 1, "import.senzeyCourseId": 1 },
  { unique: true, partialFilterExpression: { "import.senzeyCourseId": { $exists: true } } }
);

eventSchema.pre("validate", function (next) {
  const s = this.settings || {};
  if (s.ageMin != null && s.ageMax != null && s.ageMin > s.ageMax) {
    this.invalidate("settings.ageMax", "גיל מקסימלי חייב להיות גדול או שווה לגיל המינימלי");
  }
  next();
});

/** Is the event in the past (its date has passed)? */
eventSchema.virtual("isPast").get(function () {
  return this.date ? this.date.getTime() < Date.now() : false;
});

module.exports = mongoose.model("Event", eventSchema);
