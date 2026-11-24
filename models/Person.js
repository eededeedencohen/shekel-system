/**
 * @file Person model - identity only, one collection, one _id
 * @module models/Person
 *
 * The 2026 people split (see people-remodel-plan.html): Person holds ONLY
 * what is true of every human - name, contact, auth-ready fields, avatar,
 * weekly availability, soft delete. Everything role-shaped (pipeline,
 * matching, residence, taught subjects, …) lives in the `profiles`
 * collection (models/Profile.js + models/profiles/*): one profile document
 * per (person, kind), so a person can be a hostel manager AND a culture
 * student without duplicating the human.
 *
 * Every ref in the system (cycle.teacher, enrollment.student,
 * lesson.attendance.student) keeps pointing at THIS _id - the split did
 * not move identity.
 *
 * Invariants that live HERE, not in controllers:
 *  - availability is the ONE home for weekly windows (shared TimeRange).
 *  - People are soft-deleted (deletedAt) - never hard-deleted while
 *    enrollments/lessons reference them.
 */

const mongoose = require("mongoose");
const { timeRangeSchema } = require("./schemas/timeRange");

const personSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "חובה להזין שם פרטי"],
      trim: true,
    },
    lastName: { type: String, default: "", trim: true },
    /**
     * OPTIONAL - unique when present (partial index). Doubles as
     * the future login identifier.
     */
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "אנא הזן כתובת אימייל חוקית"],
    },
    phone: { type: String, trim: true },
    birthDate: { type: Date },
    gender: {
      type: String,
      enum: { values: ["male", "female", "other"], message: "{VALUE} אינו ערך מין חוקי" },
    },
    /**
     * מספר תעודת הזהות (Eden, 2026-11-24: "חייבים תעודות זהות של כל
     * הסטודנטים" - the social worker types it in שקדיה). Nine digits, the
     * check digit verified on the way in (utils/israeliId). `select: false`:
     * NO query of the app returns it - only GET /api/people/:id/id-number
     * asks for it by name, and only for the kinds of domain.ID_NUMBER_KINDS.
     * It is never in a list, a populate, a slice of the client or the audit.
     */
    idNumber: { type: String, trim: true, select: false },
    /** Stable senzey join key - idempotent re-import anchor. */
    senzeyId: { type: String, trim: true },
    joinedShekelDate: { type: Date },
    /** DiceBear/bigheads avatar config - deliberately free-form. */
    avatar: { type: mongoose.Schema.Types.Mixed },
    /**
     * THE weekly-availability home for every person - the same TimeRange
     * subschema, on the same path, whatever the profiles say.
     */
    availability: [
      timeRangeSchema({
        /**
         * Who the window is for (Eden, 2026-10-14): a window the teacher
         * marked (or the teachers' app synced) is nobody's - any program may
         * use it; a window a program's staff marked after a phone call is
         * that program's alone - the other program sees it as "freed for
         * X" and may neither use nor change it.
         */
        program: { type: String, enum: ["college", "hostels", null], default: null },
      }),
    ],
    /** Future login - already has a home; never selected by default. */
    auth: {
      passwordHash: { type: String, select: false },
      lastLoginAt: { type: Date },
    },
    /** Soft delete - list queries filter deletedAt:null. */
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "people",
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

personSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true } } }
);
// one person per ID number (only where one is written)
personSchema.index(
  { idNumber: 1 },
  { unique: true, partialFilterExpression: { idNumber: { $type: "string" } } }
);
personSchema.index(
  { senzeyId: 1 },
  { unique: true, partialFilterExpression: { senzeyId: { $exists: true } } }
);

/** person.profiles - populate on demand ("what is this person in Shekel"). */
personSchema.virtual("profiles", {
  ref: "Profile",
  localField: "_id",
  foreignField: "person",
});

const Person = mongoose.model("Person", personSchema);

module.exports = { Person };
