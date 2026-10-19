/**
 * @file Supplier model - a supplier being opened (פתיחת תיק ספק)
 * @module models/Supplier
 *
 * Eden (2026-10-14): the hostels coordinator opens a supplier - a name, a
 * gender (so the messages read right) and a phone - and gets a link to
 * send on WhatsApp. Behind the link the supplier fills the paper form
 * ("פתיחת תיק ספק - עמותת שק״ל") and uploads the certificates; the
 * coordinator checks every item, generates the summary and sends the
 * mail. One row per supplier; the file bytes live in `files` (StoredFile),
 * this row keeps what they are and what the coordinator said about them.
 *
 * `status` is derived from the facts on every save (supplierService
 * computeStatus) - it is stored only so a list can filter and sort by it.
 */

const mongoose = require("mongoose");
const {
  WORLDS,
  SUPPLIER_GENDER_KEYS,
  SUPPLIER_FILE_KEYS,
  SUPPLIER_FIELD_KEYS,
  SUPPLIER_STATUSES,
  SUPPLIER_REVIEW_STATES,
  SUPPLIER_PAYMENT_TERMS,
} = require("../utils/domain");

/** What the coordinator said about one item (the form, or one file). */
const reviewSchema = new mongoose.Schema(
  {
    state: { type: String, enum: SUPPLIER_REVIEW_STATES, default: "pending" },
    /** "מה לא תקין" - required when the state is bad. */
    note: { type: String, trim: true },
    /** The form only: which fields are wrong (keys of SUPPLIER_FIELDS). */
    fields: [{ type: String, enum: SUPPLIER_FIELD_KEYS }],
    at: { type: Date },
    by: { type: String, trim: true },
  },
  { _id: false }
);

const fileRowSchema = new mongoose.Schema(
  {
    key: { type: String, enum: SUPPLIER_FILE_KEYS, required: true },
    /** The bytes (models/StoredFile) and what they are - empty while nothing was uploaded. */
    file: {
      stored: { type: mongoose.Schema.Types.ObjectId, ref: "StoredFile" },
      name: { type: String, trim: true },
      mime: { type: String, trim: true },
      size: { type: Number, min: 0 },
      thumb: { type: Boolean, default: false },
      uploadedAt: { type: Date },
    },
    /** The optional certificate the supplier said does not apply to them. */
    notApplicable: { type: Boolean, default: false },
    review: { type: reviewSchema, default: () => ({ state: "pending" }) },
  },
  { _id: false }
);

/** Something the supplier did that the coordinator has not looked at yet. */
const updateSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    kind: { type: String, enum: ["form", "file", "opened"], required: true },
    key: { type: String, trim: true },
    text: { type: String, trim: true, required: true },
    seenAt: { type: Date },
  },
  { _id: false }
);

const supplierSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    gender: { type: String, enum: SUPPLIER_GENDER_KEYS, required: true },
    phone: { type: String, required: true, trim: true },
    createdBy: { type: String, trim: true },
    /** The שק״ל person this file belongs to, when it is one of ours - a teacher's file sits on their page (שמרית, 2026-10-14). */
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    /** The public link: the token is the only key to this row from outside. */
    link: {
      token: { type: String, required: true, trim: true },
      expiresAt: { type: Date, required: true },
      days: { type: Number },
      createdAt: { type: Date, default: Date.now },
      by: { type: String, trim: true },
      /** The supplier opened the page (first time / last time). */
      openedAt: { type: Date },
      lastOpenedAt: { type: Date },
    },
    /** The paper form's fields, as the supplier typed them. */
    form: {
      companyName: { type: String, trim: true },
      businessId: { type: String, trim: true },
      address: {
        city: { type: String, trim: true },
        street: { type: String, trim: true },
        number: { type: String, trim: true },
        zip: { type: String, trim: true },
      },
      officePhone: { type: String, trim: true },
      contactName: { type: String, trim: true },
      contactPhone: { type: String, trim: true },
      contactEmail: { type: String, trim: true, lowercase: true },
      accountOwners: { type: String, trim: true },
      bank: { code: { type: Number }, name: { type: String, trim: true } },
      branch: { code: { type: Number }, name: { type: String, trim: true } },
      accountNumber: { type: String, trim: true },
      paymentTerms: { type: String, default: SUPPLIER_PAYMENT_TERMS },
    },
    formSubmittedAt: { type: Date },
    formUpdatedAt: { type: Date },
    formReview: { type: reviewSchema, default: () => ({ state: "pending" }) },
    files: { type: [fileRowSchema], default: () => SUPPLIER_FILE_KEYS.map((key) => ({ key })) },
    updates: { type: [updateSchema], default: [] },
    /** The coordinator's last steps: the summary, the two copies, the mail. */
    email: {
      pdfAt: { type: Date },
      subjectAt: { type: Date },
      bodyAt: { type: Date },
      sentAt: { type: Date },
      sentBy: { type: String, trim: true },
      to: { name: { type: String, trim: true }, gender: { type: String, enum: [...SUPPLIER_GENDER_KEYS, ""] } },
    },
    status: { type: String, enum: SUPPLIER_STATUSES, default: "link", index: true },
  },
  { timestamps: true, collection: "suppliers" }
);

supplierSchema.index({ world: 1, "link.token": 1 }, { unique: true });
supplierSchema.index({ world: 1, status: 1, updatedAt: -1 });
supplierSchema.index({ world: 1, person: 1 });

/** Still open right now? */
supplierSchema.methods.linkLive = function () {
  return !!this.link?.expiresAt && this.link.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model("Supplier", supplierSchema);
