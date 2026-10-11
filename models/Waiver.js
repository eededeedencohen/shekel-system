/**
 * @file Waiver model - a signed ויתור סודיות (collection `waivers`)
 * @module models/Waiver
 *
 * Eden (2026-10-11), holding the old system's form: "אני רוצה טופס יפה
 * יותר מזה למערכת שלנו ושיהיה נוח לעובדת הסוציאלית לעבוד עם זה במקביל
 * לאינטייק". The social worker fills the form WITH the person during the
 * meeting and both sign on the screen; this row is what was agreed:
 * which parties the information may pass to and from, who witnessed,
 * a guardian when there is one, and the signatures. The signed page
 * itself is rendered by the client and stored as the intake's "waiver"
 * document (`file` → models/StoredFile), so it is viewed and sent like
 * any other document; the record (models/Activity, kind `waiver`) tells
 * the story in the history.
 *
 * The person's ID number is written on the signed page only - never
 * here, never on the person (the house rule: ID numbers are not stored).
 * The signature images never travel in JSON (the signed page carries
 * them).
 */

const mongoose = require("mongoose");
const { WORLDS, WAIVER_PARTY_KEYS } = require("../utils/domain");

const partySchema = new mongoose.Schema(
  {
    /** Which kind of party (domain WAIVER_PARTIES); `other` for a free one. */
    key: { type: String, enum: WAIVER_PARTY_KEYS, required: true },
    label: { type: String, trim: true },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const waiverSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    intake: { type: mongoose.Schema.Types.ObjectId, ref: "Intake", required: true, index: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, index: true },
    /** When the person signed - the year of validity counts from here. */
    signedAt: { type: Date, required: true },
    validUntil: { type: Date },
    /** The staff member who ran the signing (the persona's name). */
    by: { type: String, trim: true },
    /** The social worker confirmed she explained what the waiver means. */
    explained: { type: Boolean, default: false },
    parties: { type: [partySchema], default: [] },
    witness: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      role: { type: String, trim: true },
    },
    guardian: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      relation: { type: String, trim: true },
      phone: { type: String, trim: true },
      address: { type: String, trim: true },
    },
    /** PNG images drawn on the screen (never in JSON). */
    signatures: {
      student: { type: Buffer },
      witness: { type: Buffer },
      guardian: { type: Buffer },
    },
    /** The signed page, as stored for the intake's "waiver" document. */
    file: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile" },
    /** The row in the record that tells it. */
    activity: { type: mongoose.Schema.Types.ObjectId, ref: "Activity" },
  },
  { timestamps: true, collection: "waivers" }
);

waiverSchema.index({ world: 1, intake: 1, signedAt: -1 });

function stripSignatures(doc, ret) {
  if (ret.signatures) {
    ret.signatures = {
      student: !!(doc.signatures?.student?.length),
      witness: !!(doc.signatures?.witness?.length),
      guardian: !!(doc.signatures?.guardian?.length),
    };
  }
  return ret;
}
waiverSchema.set("toJSON", { transform: stripSignatures });
waiverSchema.set("toObject", { transform: stripSignatures });

module.exports = mongoose.model("Waiver", waiverSchema);
