/**
 * @file PersonTag + PersonTagEvent models — a person's belongings
 * @module models/PersonTag
 *
 * One row per belonging of a person (collection `personTags`): which tag,
 * since when, until when (`until` empty = open now). A person holds a tag
 * once at a time; closing and reopening keep the SAME row and write the
 * story into `personTagEvents` (opened / closed / reopened /
 * transferredOut / transferredIn, with `otherTag` on a transfer) — rows
 * there are only added, never changed.
 *
 * The only writers are services/tagService (give / take / reopen) and the
 * migration that reads the old profiles (services/tagMigration).
 */

const mongoose = require("mongoose");
const { WORLDS, PROFILE_EVENT_KEYS } = require("../utils/domain");

const personTagSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true, immutable: true },
    tag: { type: mongoose.Schema.Types.ObjectId, ref: "Tag", required: true, immutable: true },
    since: { type: Date, default: Date.now },
    until: { type: Date, default: null },
  },
  { timestamps: true, collection: "personTags" }
);
personTagSchema.index({ person: 1, tag: 1 }, { unique: true });
personTagSchema.index({ world: 1, tag: 1, until: 1 });

const personTagEventSchema = new mongoose.Schema(
  {
    world: { type: String, enum: WORLDS, required: true, default: "real", immutable: true },
    personTag: { type: mongoose.Schema.Types.ObjectId, ref: "PersonTag", required: true },
    event: { type: String, enum: PROFILE_EVENT_KEYS, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, trim: true },
    note: { type: String, trim: true },
    otherTag: { type: mongoose.Schema.Types.ObjectId, ref: "Tag", default: null },
  },
  { timestamps: true, collection: "personTagEvents" }
);
personTagEventSchema.index({ personTag: 1, at: 1 });

const PersonTag = mongoose.model("PersonTag", personTagSchema);
const PersonTagEvent = mongoose.model("PersonTagEvent", personTagEventSchema);

module.exports = { PersonTag, PersonTagEvent };
