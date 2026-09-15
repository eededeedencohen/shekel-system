/**
 * @file EventRegistration model — a culture student ↔ an event
 * @module models/EventRegistration
 *
 * ONE record per (event, student) — the ERD draws two diamonds ("נרשם
 * לאירוע" and "נמצא ברשימת המתנה") but they are two STATES of the same
 * relationship, so they share a document and a unique index: a student can
 * never be both registered and waitlisted for the same event, and the
 * promotion from the waitlist is a status flip with a history entry.
 *
 *  - status      registered | waitlisted | cancelled
 *  - waitlist    {position, since, addedBy} while waitlisted (the ERD's
 *                מיקום ברשימה / חתימת זמן / הוכנס ע"י)
 *  - attendance  the ERD's נכח? + הערות — reported by staff after the event;
 *                null until reported ("לא דווח" is inferred, never stored)
 *  - history     the ERD's היסטוריית הרשמות: every action with its actor
 *                (a person — the student themself or culture staff),
 *                timestamp and reason. Append-only.
 *
 * Every write goes through services/cultureService (actor validation,
 * capacity, eligibility, promotion). The index backstops duplicates.
 */

const mongoose = require("mongoose");
const { WORLDS, REGISTRATION_STATUSES, REGISTRATION_ACTION_KEYS } = require("../utils/domain");

const historySchema = new mongoose.Schema(
  {
    action: { type: String, enum: REGISTRATION_ACTION_KEYS, required: true },
    at: { type: Date, default: Date.now },
    /** מבצע הפעולה — the student or a ManagerCulture (service-checked). */
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Person" },
    reason: { type: String, trim: true },
  },
  { _id: false }
);

const registrationSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, immutable: true },
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: [true, "רישום חייב אירוע"],
      immutable: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Person",
      required: [true, "רישום חייב סטודנט/ית"],
      immutable: true,
    },
    status: { type: String, enum: REGISTRATION_STATUSES, required: true },
    /**
     * אורח/ת — a person WITHOUT a culture profile brought along by staff
     * (family at "ערב הורים וילדים", a friend at a show). The senzey data
     * carries these as student type "אורח/ת". Guests never count as
     * members; staff only.
     */
    isGuest: { type: Boolean, default: false },
    waitlist: {
      position: { type: Number, min: 1 },
      since: { type: Date },
      addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Person" },
    },
    attendance: {
      present: { type: Boolean },
      note: { type: String, trim: true },
      reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Person" },
      reportedAt: { type: Date },
    },
    registeredAt: { type: Date },
    cancelledAt: { type: Date },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, collection: "eventRegistrations" }
);

registrationSchema.index({ event: 1, student: 1 }, { unique: true });
registrationSchema.index({ event: 1, status: 1, "waitlist.position": 1 });
registrationSchema.index({ student: 1, status: 1 });
registrationSchema.index({ world: 1, status: 1 });

module.exports = mongoose.model("EventRegistration", registrationSchema);
