/**
 * @file Intake model — one person's קליטה (intake) case
 * @module models/Intake
 *
 * The social worker meets a HUMAN once, whichever programs they join —
 * so the intake facts live here, one document per (world, person), and
 * NOT on the two student profiles (a person in both programs would carry
 * the same checklist twice). The profiles keep their own pipeline stage;
 * services/intakeService moves them in lockstep with this record.
 *
 * The tags of Eden's spec (2026-09-17), with the social worker's
 * corrections (2026-10-07), are all derived from here:
 *   סטטוס עובדת סוציאלית  scheduled.at / done.at   (new → scheduled → done)
 *   קליטה בשקדיה           shkedia.enteredAt — the COORDINATOR enters the
 *                          person in שקדיה and marks it here; nothing
 *                          arrives from outside (the old "אישור שקדייה"
 *                          document row is gone)
 *   מסמכים                 the `documents[]` rows of the required keys,
 *                          each in force (validUntil ahead of today)
 *
 *   status  new ──schedule──▶ scheduled ──done──▶ documents ──שקדיה + docs──▶ complete
 *                                            └──(everything already in)──────▶ complete
 *
 *   profile  תרבות: Interested ─▶ Intake ─▶ Placed
 *            מכללה: Intake ─▶ AwaitingPlacement (a seat is held; the managers
 *                   enter the start date → Placed — enrollmentService)
 *
 * `landing` is what the public sign-up page wrote (who filled it, which
 * programs, preferences); `landing.token` is the personal link that lets
 * the student come back and upload the rest of the documents — it now
 * EXPIRES (`landing.linkExpiresAt`, LANDING_LINK_HOURS after a submission);
 * after that the coordinator hands out a temporary link (models/UploadLink).
 * `coordinator` is the staff member who owns the file (her stage 3),
 * `screening` the facts of the first call (her stage 1), `committeeDate`
 * the rehab committee's date (the evaluation clock), `shkedia` the
 * admission in שקדיה (her stage 5).
 * `documents[]` holds one row per INTAKE_DOCUMENTS key — the file bytes
 * live in `files` (models/StoredFile, `file.stored`); records from before
 * 2026-10-07 may still point at the disk (`file.storedName`, read-only
 * until scripts/migrateDocsToDb.js moves them). Rows of retired keys are
 * dropped on save.
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
  SCREENING_ELIGIBILITY_KEYS,
  SCREENING_INTEREST_KEYS,
} = require("../utils/domain");

const documentSchema = new mongoose.Schema(
  {
    /** An INTAKE_DOCUMENTS key — checked by the service (no enum here, so a
     *  record seeded under an older checklist still loads; see the save hook). */
    key: { type: String, trim: true, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: "missing" },
    /** The stored file, when one was uploaded (student or staff). */
    file: {
      name: { type: String, trim: true },
      /** The bytes, in the `files` collection (since 2026-10-07). */
      stored: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile" },
      /** Legacy: a file still on the server's disk (UPLOAD_DIR/<world>/<intakeId>/). */
      storedName: { type: String, trim: true },
      mime: { type: String, trim: true },
      size: { type: Number, min: 0 },
      uploadedAt: { type: Date },
      /** "student" (via a link) or a staff persona name. */
      by: { type: String, trim: true },
    },
    receivedAt: { type: Date },
    receivedBy: { type: String, trim: true },
    /** validity "signed" (ויתור סודיות): when it was signed — validUntil is computed from it. */
    signedAt: { type: Date },
    /** When the document stops being in force (typed for "dated", computed for "signed"). */
    validUntil: { type: Date },
    /** The staff's comment — a rejection reason or a reply the student sees on the personal link. */
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
      /** The personal link stops working here (LANDING_LINK_HOURS after the last submission). */
      linkExpiresAt: { type: Date },
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

    /** The staff member who owns the file (her stage 3: "העברה לטיפול רכזת"). */
    coordinator: {
      name: { type: String, trim: true },
      since: { type: Date },
      by: { type: String, trim: true },
    },

    /** The first call's facts (her stage 1). */
    screening: {
      calledAt: { type: Date },
      by: { type: String, trim: true },
      eligibility: { type: String, enum: SCREENING_ELIGIBILITY_KEYS },
      interests: [{ type: String, enum: SCREENING_INTEREST_KEYS }],
      note: { type: String, trim: true },
    },

    /** The rehab committee's date — the evaluation clock counts from here. */
    committeeDate: { type: Date },

    /** The meeting the social worker set. */
    scheduled: {
      at: { type: Date },
      by: { type: String, trim: true },
      note: { type: String, trim: true },
      setAt: { type: Date },
    },
    /** The meeting happened (+ the waiver signed there, + the template's fields). */
    done: {
      at: { type: Date },
      by: { type: String, trim: true },
      waiverSignedAt: { type: Date },
      summary: { type: String, trim: true },
    },

    /** Entered in שקדיה by the coordinator (her stage 5) — with the date and the committee's decision number. */
    shkedia: {
      enteredAt: { type: Date },
      by: { type: String, trim: true },
      decisionNo: { type: String, trim: true },
      note: { type: String, trim: true },
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

/** Rows of retired document keys never survive a save. */
intakeSchema.pre("save", function (next) {
  if (Array.isArray(this.documents) && this.documents.some((d) => !INTAKE_DOCUMENT_KEYS.includes(d.key))) {
    this.documents = this.documents.filter((d) => INTAKE_DOCUMENT_KEYS.includes(d.key));
  }
  next();
});

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
