/**
 * @file Enrollment model — first-class membership in a cycle
 * @module models/Enrollment
 *
 * The ONE definition of occupancy, roster and held seats:
 *   free seats = capacity − count({cycle, status ∈ [reserved, active]})
 *
 * A reservation is the same record with status "reserved" — fulfilling it
 * is a single-document status flip, replacing the old three uncoordinated
 * writes across two collections. The unique {cycle, student} index makes
 * double-enrollment impossible from EVERY write path — no controller can
 * forget the check.
 *
 * Membership facts only — scheduling lives solely on cycles.schedule;
 * a private-cycle student links to their slot via slotId.
 *
 * Future waitlist extension point: a new status value or a sibling
 * collection hangs off this shape (deliberately not designed yet).
 */

const mongoose = require("mongoose");
const { WORLDS, ENROLLMENT_STATUSES } = require("../utils/domain");

const enrollmentSchema = new mongoose.Schema(
  {
    cycle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cycle",
      required: [true, "שיבוץ חייב מחזור"],
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Person",
      required: [true, "שיבוץ חייב סטודנט"],
    },
    /** Write-once, copied from the cycle by the service (WORLD_MISMATCH is
     *  rejected there) — a declared denormalized copy, for indexing. */
    world: { type: String, enum: WORLDS, required: true, immutable: true },
    status: {
      type: String,
      enum: ENROLLMENT_STATUSES, // reserved | active | completed | left
      required: true,
    },
    /** _id of a cycle.schedule slot (private cycles / per-student times).
     *  null = attends all the cycle's slots. Validated by the service. */
    slotId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Meaningful start date (the old senzey receivedDate). */
    joinedAt: { type: Date },
    /** Senzey system row-creation timestamp (the old registrationDate). */
    registeredAt: { type: Date },
    /** Membership end — distinct from the cycle's own endDate. */
    leftAt: { type: Date },
    reservedAt: { type: Date },
    note: { type: String, trim: true },
    /** Persona name until auth exists; becomes a Person ref later. */
    createdBy: { type: String, trim: true },
    import: {
      isActiveFlag: { type: Boolean },
    },
  },
  { timestamps: true }
);

// Double-enroll impossible from ANY write path.
enrollmentSchema.index({ cycle: 1, student: 1 }, { unique: true });
enrollmentSchema.index({ student: 1, status: 1 });
enrollmentSchema.index({ cycle: 1, status: 1 });
enrollmentSchema.index({ world: 1, status: 1 });

enrollmentSchema.pre("validate", function (next) {
  if (this.joinedAt && this.leftAt && this.leftAt < this.joinedAt) {
    this.invalidate("leftAt", "תאריך העזיבה חייב להיות אחרי תאריך ההצטרפות");
  }
  next();
});

module.exports = mongoose.model("Enrollment", enrollmentSchema);
