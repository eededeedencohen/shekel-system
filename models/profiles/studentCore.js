/**
 * @file Shared student-profile core — pipeline + stage history + guards
 * @module models/profiles/studentCore
 *
 * Both student kinds (StudentCollege, StudentCulture) carry an intake
 * pipeline — and because the pipeline now lives on the PROFILE, each
 * department runs its own: a person can be Placed in the college and
 * Interested in culture at the same time, each with its own history.
 *
 * The old Person-level invariants moved here unchanged:
 *  - pipeline.{stage,since} is the single declared denormalized copy of
 *    stageHistory's tail; moveToStage() is the ONLY writer.
 *  - a pre-save hook asserts stage === history tail.
 *  - query-update hooks BLOCK direct writes to either field.
 */

const { PIPELINE_STAGE_KEYS } = require("../../utils/domain");

/** Paths every student profile shares — spread into each student schema. */
const studentCorePaths = {
  /** Denormalized tail of stageHistory — kanban columns come from here. */
  pipeline: {
    stage: {
      type: String,
      enum: { values: PIPELINE_STAGE_KEYS, message: "{VALUE} אינו שלב חוקי בצנרת הקליטה" },
    },
    since: { type: Date },
  },
  /** Append-only audit trail; movedBy stays a persona string until auth. */
  stageHistory: [
    {
      stage: { type: String, enum: PIPELINE_STAGE_KEYS, required: true },
      movedBy: { type: String, trim: true },
      movedAt: { type: Date, default: Date.now },
      note: { type: String, trim: true },
    },
  ],
};

/** Attach the pipeline invariants + moveToStage() to a student schema. */
function applyStudentCore(schema) {
  /** Sync-rule assertion: pipeline.stage must equal the history tail. */
  schema.pre("save", function (next) {
    if (this.isModified("pipeline") || this.isModified("stageHistory")) {
      const tail = this.stageHistory[this.stageHistory.length - 1];
      if ((this.pipeline?.stage || null) !== (tail?.stage || null)) {
        return next(
          new Error("pipeline.stage חייב להשתוות לשלב האחרון ב-stageHistory — השתמשו ב-moveToStage()")
        );
      }
    }
    next();
  });

  /**
   * The ONE writer of the pipeline pair. Appends to history and syncs the
   * denormalized head in the same save.
   */
  schema.methods.moveToStage = async function (stage, movedBy, note) {
    if (!PIPELINE_STAGE_KEYS.includes(stage)) {
      const err = new Error("שלב לא חוקי בצנרת הקליטה");
      err.code = "INVALID_STAGE";
      throw err;
    }
    const movedAt = new Date();
    this.stageHistory.push({ stage, movedBy, movedAt, note });
    this.pipeline = { stage, since: movedAt };
    return this.save();
  };

  schema.index({ world: 1, "pipeline.stage": 1, "pipeline.since": 1 });
  return schema;
}

/**
 * Close the query-update bypass on the BASE model (covers every kind):
 * document saves are guarded per-schema above; these block
 * updateOne/findOneAndUpdate — the only legal writer is moveToStage().
 */
function blockPipelineQueryWrites(next) {
  const update = this.getUpdate() || {};
  const touched = [];
  const scan = (obj) => {
    for (const k of Object.keys(obj || {})) {
      if (k.startsWith("$")) scan(obj[k]);
      else if (k === "pipeline" || k.startsWith("pipeline.") || k === "stageHistory" || k.startsWith("stageHistory."))
        touched.push(k);
    }
  };
  scan(update);
  if (touched.length) {
    return next(
      new Error(`pipeline/stageHistory ניתנים לכתיבה רק דרך moveToStage() (ניסיון לעדכן: ${touched.join(", ")})`)
    );
  }
  next();
}

module.exports = { studentCorePaths, applyStudentCore, blockPipelineQueryWrites };
