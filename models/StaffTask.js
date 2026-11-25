/**
 * @file StaffTask - a task the super admin gives someone on the staff
 * @module models/StaffTask
 *
 * Eden (2026-11-25): "תיצור לי עמוד שנקרא משימות… עמוד שבו אני כרגע יכול
 * לתת משימות לעובדים האחרים. זה יהיה כמובן בתפריט עם המספר עבור המשימות
 * שלא בוצעו עדיין. יהיה אפשרות לנהל צ'אט שם פרטי ביני לבין העובד".
 *
 * One row = one task for one person: what is asked, in words; a key to the
 * page where it is done (`linkTo`, an address inside the app); whether it
 * was done; and the talk about it between the two (`messages`) - seen by
 * the one who got it and by the super admin, and by nobody else.
 *
 * `auto` names a rule the app checks by itself: such a task is done when
 * the rule holds, not when somebody says so ("המשימה תבוצע כאשר שמרית תיתן
 * סימון לכולם" - services/staffTaskService AUTO).
 *
 * Not the dashboard's tasks (client lib/tasks.js): those are the day's work
 * read from the data; these are asked by a person, of a person.
 */

const mongoose = require("mongoose");

/** The rules a task can be done by on its own (services/staffTaskService AUTO). */
const TASK_AUTO_RULES = ["weekCensusChecked"];

const messageSchema = new mongoose.Schema(
  {
    /** the account that wrote it (its id as text) */
    from: { type: String, required: true },
    fromName: { type: String, trim: true, maxlength: 80, default: "" },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const staffTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, trim: true, maxlength: 4000, default: "" },
    /** who it was given to: the account's id as text */
    assignee: { type: String, required: true, index: true },
    assigneeName: { type: String, trim: true, maxlength: 80, default: "" },
    /** who gave it */
    by: { type: String, required: true },
    byName: { type: String, trim: true, maxlength: 80, default: "" },
    /** a key on the task to the page where it is done: an address inside the app ("/hostel-week?tab=week") and its words */
    linkTo: { type: String, trim: true, maxlength: 200, default: "" },
    linkLabel: { type: String, trim: true, maxlength: 80, default: "" },
    auto: { type: String, enum: [...TASK_AUTO_RULES, null], default: null },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    doneBy: { type: String, trim: true, maxlength: 80, default: "" },
    messages: [messageSchema],
    /** account id → the last time that account looked at the task (what is new in the talk is counted from it) */
    seen: { type: Map, of: Date, default: {} },
  },
  { timestamps: true, collection: "staffTasks" }
);

const StaffTask = mongoose.model("StaffTask", staffTaskSchema);
StaffTask.TASK_AUTO_RULES = TASK_AUTO_RULES;

module.exports = StaffTask;
