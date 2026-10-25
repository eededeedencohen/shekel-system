/**
 * @file HostelReport - one hostel's attendance DRAFT for one month, behind
 * a temporary link to the house's own contact (phase 3 of שמרית's round;
 * the talk of 2026-10-14: "לפעמים עדיף להשאיר שטחים אפורים" - theirs is a
 * sketch, hers is the report).
 *
 * `sessions` are the month's planned meetings of the hostel's courses
 * (from the cycles' weekly slots). The contact says of each: held or not,
 * who came, and why someone did not (ABSENCE_REASONS - the reason is what
 * keeps a false report away from the Ministry of Health). `extras` are
 * people who came and are not on the list (= a new resident); `left` are
 * residents who are gone. Nothing here touches the attendance: the
 * coordinator approves a session (it becomes the Lesson's attendance, with
 * the reasons) and settles the extras and the leavers one by one.
 * @module models/HostelReport
 */

const mongoose = require("mongoose");
const { ABSENCE_REASON_KEYS, HOSTEL_REPORT_SESSION_STATES, HOSTEL_REPORT_MARKS } = require("../utils/domain");

const markSchema = new mongoose.Schema(
  {
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    status: { type: String, enum: HOSTEL_REPORT_MARKS, required: true },
    reason: { type: String, enum: [...ABSENCE_REASON_KEYS, null], default: null },
    note: { type: String, trim: true },
    /**
     * The house's own word, kept the moment the coordinator changed this
     * mark (Eden, 2026-10-25: she may say someone came when the house said
     * not - "אבל כמובן יהיה רשום אצלה שבהוסטל דיווחו משהו שונה"). Absent
     * when the mark is hers from the start. Never leaves for the Ministry.
     */
    house: {
      status: { type: String, enum: [...HOSTEL_REPORT_MARKS, null], default: undefined },
      reason: { type: String, enum: [...ABSENCE_REASON_KEYS, null], default: undefined },
      note: { type: String, trim: true },
    },
    staffAt: { type: Date },
    staffBy: { type: String, trim: true },
  },
  { _id: false }
);

const sessionSchema = new mongoose.Schema(
  {
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: "Cycle", required: true },
    /** UTC midnight of the planned day (how Lesson.date is stored). */
    date: { type: Date, required: true },
    slotId: { type: mongoose.Schema.Types.ObjectId },
    start: { type: String, trim: true },
    end: { type: String, trim: true },
    state: { type: String, enum: [...HOSTEL_REPORT_SESSION_STATES, null], default: null },
    markedAt: { type: Date },
    marks: { type: [markSchema], default: [] },
    /** The house's word on held / not held once the coordinator changed it (null = the house had not marked it). Meaningful only with staffAt. */
    houseState: { type: String, enum: [...HOSTEL_REPORT_SESSION_STATES, null], default: null },
    /** The coordinator marked or changed this session herself - from then on the house's page shows it shut. */
    staffAt: { type: Date },
    staffBy: { type: String, trim: true },
    /** Set when the coordinator approved it: the Lesson row the marks became. */
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", default: null },
    approvedAt: { type: Date },
    approvedBy: { type: String, trim: true },
  },
  { _id: true }
);

/** Someone who came and is not on the list - a new resident, once the coordinator adds them. */
const extraSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    note: { type: String, trim: true },
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: "Cycle", default: null },
    addedAt: { type: Date, default: Date.now },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", default: null },
    resolvedAt: { type: Date },
    resolvedBy: { type: String, trim: true },
  },
  { _id: true }
);

/** A resident who left the house - closes their residence once the coordinator confirms. */
const leftSchema = new mongoose.Schema(
  {
    person: { type: mongoose.Schema.Types.ObjectId, ref: "Person", required: true },
    date: { type: Date, required: true },
    note: { type: String, trim: true },
    addedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: String, trim: true },
  },
  { _id: true }
);

const hostelReportSchema = new mongoose.Schema(
  {
    hostel: { type: mongoose.Schema.Types.ObjectId, ref: "Hostel", required: true },
    /** "2026-10" */
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    token: { type: String, required: true, trim: true },
    expiresAt: { type: Date, required: true },
    /** Who the link is for - the house's reporter as known when the month opened. */
    contact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    openedBy: { type: String, trim: true },
    sentAt: { type: Date },
    sentBy: { type: String, trim: true },
    openedAt: { type: Date },
    lastOpenedAt: { type: Date },
    completedAt: { type: Date },
    sessions: { type: [sessionSchema], default: [] },
    extras: { type: [extraSchema], default: [] },
    left: { type: [leftSchema], default: [] },
    /** What the contact wrote on the way out. */
    note: { type: String, trim: true },
    /** The coordinator's own note on the month. */
    staffNote: { type: String, trim: true },
  },
  { timestamps: true, collection: "hostelReports" }
);

hostelReportSchema.index({ token: 1 }, { unique: true });
hostelReportSchema.index({ hostel: 1, month: 1 }, { unique: true });
hostelReportSchema.index({ month: -1 });

hostelReportSchema.methods.linkLive = function () {
  return !!this.expiresAt && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model("HostelReport", hostelReportSchema);
