/**
 * @file DocTemplate model - a written template someone on the staff made
 * @module models/DocTemplate
 *
 * Eden (2026-11-19): "אני רוצה אפשרות של יצירת תבניות והצפייה עריכה
 * וניהול שלהם… כמו מיני docs באפליקציה. מי שיוצר את הטמפלט הוא היחיד
 * שיכול לערוך אותו אבל כולם יכולים להשתמש בו (בינתיים) ואפילו להעתיק
 * אותו לטמפלט משלהם".
 *
 * One row = one document with its design (utils/richDoc - a tree of known
 * blocks and marks, never HTML). `owner` is the account that made it (the
 * ACTING one - a super admin viewing as someone writes theirs, like the
 * diary) and the only one that may change or delete it; everyone on the
 * staff reads all of them, writes a record entry from any of them, and may
 * copy one into a template of their own (`copiedFrom` remembers where it
 * came from). `kind` says which entry of a person's record it was written
 * for (a follow-up call, an evaluation call…) - empty: any.
 *
 * Not to be confused with ActivityTemplate: that one is the FORM of a
 * kind of entry (its small fields, one per kind, the social worker's);
 * these are the texts people write from, as many as they like.
 */

const mongoose = require("mongoose");
const { DOC_TEMPLATE_KINDS } = require("../utils/domain");

const docTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Which kind of record entry it serves; null = any. */
    kind: { type: String, enum: [...DOC_TEMPLATE_KINDS, null], default: null },
    /** The document (utils/richDoc cleanDoc). */
    doc: { type: mongoose.Schema.Types.Mixed, required: true },
    /** The same document as plain lines - previews and search. */
    text: { type: String, default: "" },
    /** The acting account that made it (its id as text) - the only one that may change it. */
    owner: { type: String, required: true, index: true },
    ownerName: { type: String, trim: true, default: "" },
    copiedFrom: {
      template: { type: mongoose.Schema.Types.ObjectId, ref: "DocTemplate" },
      name: { type: String, trim: true },
      ownerName: { type: String, trim: true },
    },
  },
  { timestamps: true, collection: "docTemplates" }
);

module.exports = mongoose.model("DocTemplate", docTemplateSchema);
