/**
 * @file GymMembership model - one person in the gym program (חדר כושר פרופיט)
 * @module models/GymMembership
 *
 * Eden (2026-10-29): the gym app moves into the system. A person who
 * belongs to the gym carries the `gym` program tag and ONE row here (the
 * small table for one concern): the membership status with the old app's
 * transitions, the personal signing link, and what was signed - the name
 * as signed, the ID number (here alone, never on the Person - the waiver's
 * rule), the phone, when, and the signature's key in the bucket.
 *
 * The STAGE is never stored (ממתין → נשלח קישור → חתום): it is read from
 * `linkSentAt` and `contract` (services/gymService stageOf). Leaving the
 * program sets `endedAt` and closes the tag; the row stays with its
 * contract, and coming back revives it. `source` remembers the old app's
 * ids so the import never writes a person twice.
 */

const mongoose = require("mongoose");
const { GYM_MEMBERSHIP_KEYS } = require("../utils/domain");

const logSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const gymMembershipSchema = new mongoose.Schema(
  {
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, unique: true },
    /** interested / active / finished / notInterested - null until the staff say (only after the signing). */
    membership: { type: String, enum: [...GYM_MEMBERSHIP_KEYS, null], default: null },
    membershipChangedAt: { type: Date, default: null },
    /** The personal signing link's secret - the server makes it, the staff JSON says `hasToken` only. */
    inviteToken: { type: String, unique: true, sparse: true, select: false },
    /** The staff pressed WhatsApp with the link (the stage "נשלח קישור"). */
    linkSentAt: { type: Date, default: null },
    contract: {
      signedAt: { type: Date, default: null },
      name: { type: String, trim: true, default: "" },
      idNumber: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      /** The signature PNG in the bucket: gym/<membership id>/signature.png */
      signatureKey: { type: String, default: "" },
    },
    notes: { type: String, trim: true, default: "" },
    endedAt: { type: Date, default: null },
    source: {
      gymStudentId: { type: String, default: "" },
      gymContractId: { type: String, default: "" },
    },
    log: { type: [logSchema], default: [] },
  },
  { timestamps: true, collection: "gymMemberships" }
);

gymMembershipSchema.index({ endedAt: 1 });
gymMembershipSchema.index({ "source.gymStudentId": 1 });

module.exports = mongoose.model("GymMembership", gymMembershipSchema);
