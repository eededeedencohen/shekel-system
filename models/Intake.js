/**
 * @file Intake model — one person's קליטה (intake) case
 * @module models/Intake
 *
 * The social worker meets a HUMAN once, whichever programs they join —
 * so the intake facts live here, one document per (world, person), and
 * NOT on the two student profiles (a person in both programs would carry
 * the same checklist twice). The profiles keep their own pipeline stage;
 * services/intakeService moves them in lockstep with this record:
 *
 *   status  new ──schedule──▶ scheduled ──done──▶ documents ──docs──▶ complete
 *                                            └──(all docs in)──────▶ complete
 *
 *   profile   Interested / ReservedSeat ─▶ Intake ─▶ AwaitingDocuments ─▶ Placed
 *                                                └────────────────────▶ Placed
 *
 * `landing` is what the public sign-up page wrote (who filled it, which
 * programs, preferences); `landing.token` is the personal link that lets
 * the student come back and upload the rest of the documents.
 * `documents[]` holds one row per INTAKE_DOCUMENTS key — the files
 * themselves live on disk (services/intakeService · UPLOAD_DIR).
 */

const mongoose = require("mongoose");
const {
  WORLDS,
  STUDENT_KINDS,
  INTAKE_STATUSES,
  INTAKE_SOURCES,
  INTAKE_FILLED_BY_KEYS,
  INTAKE_DOCUMENT_KEYS,
  DOCUMENT_STATUSES,
  INTAKE_LOG_ACTIONS,
  EVENT_CATEGORY_KEYS,
} = require("../utils/domain");

const documentSchema = new mongoose.Schema(
  {
    key: { type: String, enum: INTAKE_DOCUMENT_KEYS, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: "missing" },
    /** The stored file, when one was uploaded (student or staff). */
    file: {
      name: { type: String, trim: true },
      storedName: { type: String, trim: true },
      mime: { type: String, trim: true },
      size: { type: Number, min: 0 },
      uploadedAt: { type: Date },
      /** "student" (via the personal link) or a staff persona name. */
      by: { type: String, trim: true },
    },
    receivedAt: { type: Date },
    receivedBy: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: true }
);

const logEntrySchema = new mongoose.Schema(
  {
    action: { type: String, enum: INTAKE_LOG_ACTIONS, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const intakeSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, immutable: true },
    status: { type: String, enum: INTAKE_STATUSES, default: "new", index: true },
    source: { type: String, enum: INTAKE_SOURCES, default: "staff" },

    /** What the public sign-up page wrote. */
    landing: {
      submittedAt: { type: Date },
      /** Personal link secret — lets the student finish the documents later. */
      token: { type: String, trim: true },
      filledBy: {
        role: { type: String, enum: INTAKE_FILLED_BY_KEYS },
        name: { type: String, trim: true },
        phone: { type: String, trim: true },
      },
      programs: [{ type: String, enum: STUDENT_KINDS }],
      preferences: {
        subjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
        categories: [{ type: String, enum: EVENT_CATEGORY_KEYS }],
        /** 0–4 (Sunday–Thursday). */
        days: [{ type: Number, min: 0, max: 6 }],
        dayParts: [{ type: String, trim: true }],
        notes: { type: String, trim: true },
      },
      residenceLabel: { type: String, trim: true },
      city: { type: String, trim: true },
      emergencyContact: { type: String, trim: true },
      emergencyPhone: { type: String, trim: true },
    },

    /** The meeting the social worker set. */
    scheduled: {
      at: { type: Date },
      by: { type: String, trim: true },
      note: { type: String, trim: true },
      setAt: { type: Date },
    },
    /** The meeting happened + the waiver was signed. */
    done: {
      at: { type: Date },
      by: { type: String, trim: true },
      waiverSignedAt: { type: Date },
      summary: { type: String, trim: true },
    },
    completedAt: { type: Date },

    documents: { type: [documentSchema], default: [] },
    log: { type: [logEntrySchema], default: [] },
    notes: { type: String, trim: true },
  },
  { timestamps: true, collection: "intakes" }
);

intakeSchema.index({ world: 1, person: 1 }, { unique: true });
intakeSchema.index(
  { "landing.token": 1 },
  { unique: true, partialFilterExpression: { "landing.token": { $exists: true } } }
);
intakeSchema.index({ world: 1, status: 1, "scheduled.at": 1 });

/** world must equal the person's world — asserted once, on create. */
intakeSchema.pre("validate", async function (next) {
  if (!this.isNew || !this.person) return next();
  try {
    const person = await mongoose.model("Person").findById(this.person).select("world");
    if (!person) return next(new Error("תיק קליטה חייב להצביע על אדם קיים"));
    if (!this.world) this.world = person.world;
    if (this.world !== person.world) return next(new Error("world של תיק הקליטה חייב להשתוות ל-world של האדם"));
    next();
  } catch (e) {
    next(e);
  }
});

module.exports = mongoose.model("Intake", intakeSchema);
