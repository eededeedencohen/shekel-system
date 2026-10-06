/**
 * @file Tag + TagGroup models — what a person (or a cycle) can belong to
 * @module models/Tag
 *
 * Belonging is a tag (Eden, 2026-10-05: "שייכות למשהו יהיו תגיות… רשימה
 * של סוגים"). A tag group is a kind of belonging — "תפקיד" (role) or
 * "תוכנית" (program) — and a tag is one thing to belong to: סטודנט, מורה,
 * מכללה לכל, תרבות לכל, הוסטלים. A new program or role is a new ROW here,
 * not a new kind in the code (services/tagService holds the seed list and
 * writes it into every world once).
 *
 * Two tiny tables on purpose: `tagGroups` (key, label) and `tags` (group,
 * key, label, active). Who holds a tag is `personTags` / `cycleTags`.
 */

const mongoose = require("mongoose");
const { WORLDS } = require("../utils/domain");

const tagGroupSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: "tagGroups" }
);
tagGroupSchema.index({ world: 1, key: 1 }, { unique: true });

const tagSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    group: { type: mongoose.Schema.Types.ObjectId, ref: "TagGroup", required: true },
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "tags" }
);
tagSchema.index({ world: 1, key: 1 }, { unique: true });
tagSchema.index({ world: 1, group: 1 });

const TagGroup = mongoose.model("TagGroup", tagGroupSchema);
const Tag = mongoose.model("Tag", tagSchema);

module.exports = { Tag, TagGroup };
