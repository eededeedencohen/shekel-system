/**
 * @file Voucher model - a numbered voucher with a balance (the ERD's "שוברים")
 * @module models/Voucher
 *
 * A voucher is a physical/numbered thing tied to a place ("name - usually
 * the venue it belongs to") with a balance. It is handed to AT MOST ONE
 * student - the ERD's "קיבל שובר" relationship (מחלק השובר / תאריך מימוש /
 * מומש?) - so the grant is embedded: `grant: null` = still in stock.
 *
 * Invariants (service + schema):
 *  - number unique.
 *  - grant.by must hold an ACTIVE ManagerCulture profile; grant.student an
 *    active StudentCulture profile (cultureService).
 *  - a granted voucher cannot be granted again; a redeemed one cannot be
 *    redeemed twice.
 */

const mongoose = require("mongoose");

const grantSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    /** מחלק השובר - culture staff. */
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    at: { type: Date, default: Date.now },
    redeemed: { type: Boolean, default: false },
    redeemedAt: { type: Date },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const voucherSchema = new mongoose.Schema(
  {
    /** Where the voucher is good for - "סינמה סיטי", "קפה גרג". */
    name: { type: String, required: [true, "שם השובר הוא חובה"], trim: true },
    number: { type: String, required: [true, "מספר שובר הוא חובה"], trim: true },
    /** Remaining balance (₪). */
    balance: { type: Number, min: [0, "יתרה לא יכולה להיות שלילית"], default: 0 },
    /** Face value when received - balance starts here. */
    initialValue: { type: Number, min: 0 },
    expiresAt: { type: Date },
    notes: { type: String, trim: true },
    /**
     * The picture of the place (a logo, a storefront) - a stored file,
     * SHARED by every voucher of the same place: a new voucher for a place
     * that already has one points at the same file instead of a new upload
     * (Eden, 2026-10-13). cultureService removes the file only when the
     * last voucher pointing at it goes.
     */
    image: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile", default: null },
    grant: { type: grantSchema, default: null },
  },
  { timestamps: true }
);

voucherSchema.index({ number: 1 }, { unique: true });
voucherSchema.index({ "grant.student": 1 });

module.exports = mongoose.model("Voucher", voucherSchema);
