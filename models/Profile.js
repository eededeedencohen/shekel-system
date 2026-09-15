/**
 * @file Profile model — one document per (person, kind): "what this person
 *       is in Shekel"
 * @module models/Profile
 *
 * The base of the identity+profiles split (people-remodel-plan.html).
 * Inheritance lives HERE, where it belongs: every profile shares the same
 * skeleton (person, world, active, lifecycle log) and each user type is a
 * discriminator on `kind` under models/profiles/ — adding a user type is
 * one schema file + a registry line, no migration, no controller change.
 *
 * Invariants at the schema layer:
 *  - {person, kind} unique — a person holds each role at most once
 *    (deactivate with active:false, never duplicate; reopen later).
 *  - `world` must equal the person's world, asserted once here on create —
 *    no controller has to remember (WORLD_MISMATCH by construction).
 *  - person/world/kind are immutable — a profile never migrates between
 *    humans or worlds.
 *
 * Lifecycle ("הכל מתועד אצל הסטודנט"): `log` is the append-only story of
 * the role — opened / closed / reopened / transferredOut / transferredIn —
 * and `since`/`until` are the current open interval. A student who moves
 * from מכללה לכל to תרבות לכל keeps BOTH profiles: the old one closed with
 * transferredOut, the new one opened with transferredIn. The only writers
 * are services/programService (transfer/close/reopen) and createProfile;
 * the first save stamps `opened` by itself so no caller can forget.
 */

const mongoose = require("mongoose");
const { WORLDS, PROFILE_EVENT_KEYS } = require("../utils/domain");

const logEntrySchema = new mongoose.Schema(
  {
    event: { type: String, enum: PROFILE_EVENT_KEYS, required: true },
    at: { type: Date, default: Date.now },
    /** Persona name until auth exists; becomes a Person ref later. */
    by: { type: String, trim: true },
    note: { type: String, trim: true },
    /** The other side of a transfer (kind key), for transferredOut/In. */
    otherKind: { type: String, trim: true },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    person: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Person",
      required: [true, "פרופיל חייב אדם"],
      immutable: true,
    },
    world: { type: String, enum: WORLDS, required: true, immutable: true },
    /** Deactivate a role, keep the person (and the history). */
    active: { type: Boolean, default: true },
    /** Current open interval — since = last opened/reopened, until = closed. */
    since: { type: Date },
    until: { type: Date, default: null },
    /** Append-only lifecycle log (see PROFILE_EVENTS). */
    log: { type: [logEntrySchema], default: [] },
    notes: { type: String, trim: true },
  },
  { timestamps: true, discriminatorKey: "kind", collection: "profiles" }
);

profileSchema.index({ person: 1, kind: 1 }, { unique: true });
profileSchema.index({ world: 1, kind: 1, active: 1 });

/** world must equal the person's world — asserted once, on create. */
profileSchema.pre("validate", async function (next) {
  if (!this.isNew || !this.person) return next();
  try {
    const person = await mongoose.model("Person").findById(this.person).select("world deletedAt");
    if (!person) return next(new Error("פרופיל חייב להצביע על אדם קיים"));
    if (!this.world) this.world = person.world;
    if (this.world !== person.world) {
      return next(new Error("world של הפרופיל חייב להשתוות ל-world של האדם"));
    }
    next();
  } catch (e) {
    next(e);
  }
});

/**
 * First save = the role opens: stamp `since` and an `opened` entry unless
 * the caller (a transfer, a seed with history) already wrote the log.
 * A student profile created WITH a historical pipeline opened when that
 * pipeline began — not at insert time.
 */
profileSchema.pre("save", function (next) {
  if (this.isNew) {
    if (!this.log || !this.log.length) {
      const firstStage = Array.isArray(this.stageHistory) && this.stageHistory[0]?.movedAt;
      const at = this.since || (firstStage ? new Date(firstStage) : new Date());
      this.log = [{ event: "opened", at, by: this.$locals.openedBy, note: this.$locals.openedNote }];
      this.since = at;
    } else if (!this.since) {
      this.since = this.log[0].at;
    }
    if (this.active === false && !this.until) this.until = this.log[this.log.length - 1].at;
  }
  next();
});

// Guard pipeline/stageHistory against query-update bypasses for EVERY kind
// (harmless for kinds without a pipeline) — must be registered BEFORE the
// model is compiled, or the hooks never fire.
const { blockPipelineQueryWrites } = require("./profiles/studentCore");
profileSchema.pre("updateOne", blockPipelineQueryWrites);
profileSchema.pre("updateMany", blockPipelineQueryWrites);
profileSchema.pre("findOneAndUpdate", blockPipelineQueryWrites);

const Profile = mongoose.model("Profile", profileSchema);

module.exports = { Profile, profileSchema };
