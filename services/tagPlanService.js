/**
 * @file The students' tags plan - what the super admin decided on its open questions
 * @module services/tagPlanService
 *
 * The page /tag-plan (client: pages/TagPlan.jsx, lib/tagPlan.js) lays the
 * students' tags as they are today beside a proposal, and asks the super
 * admin a handful of questions (Eden, 2026-11-24: "עמוד שרק לי תהיה אפשרות
 * לראות שבו אנחנו מנהלים את הדברים האלה"). What he answers and the notes
 * he writes are kept here, in one AppSetting row ("tagPlan"):
 *
 *   answers  { <question key>: <option key> }
 *   notes    { <a question's or a case's key>: free text }
 *
 * Nothing in the app reads this to draw a tag: it is the record of a
 * discussion, read back by the page (and by whoever builds what was decided).
 */

const AppSetting = require("../models/AppSetting");
const AppError = require("../utils/AppError");

const KEY = "tagPlan";
const MAX_KEYS = 300;
const KEY_RE = /^[\w:.|-]{1,120}$/;
const ANSWER_RE = /^[\w-]{1,40}$/;
const NOTE_MAX = 800;

const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);

async function get() {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  const v = row?.value || {};
  return { answers: isMap(v.answers) ? v.answers : {}, notes: isMap(v.notes) ? v.notes : {}, updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || "" };
}

/**
 * Change some answers and notes; what is not in the patch stays. An answer
 * of null and an empty note take the entry off.
 */
async function set(patch, by = "") {
  const answersIn = patch?.answers;
  const notesIn = patch?.notes;
  if ((answersIn !== undefined && !isMap(answersIn)) || (notesIn !== undefined && !isMap(notesIn))) throw AppError.of("TAG_PLAN_INVALID", 400);
  if (!answersIn && !notesIn) throw AppError.of("TAG_PLAN_INVALID", 400);
  const now = await get();
  const answers = { ...now.answers };
  const notes = { ...now.notes };
  for (const [k, v] of Object.entries(answersIn || {})) {
    if (!KEY_RE.test(k)) throw AppError.of("TAG_PLAN_INVALID", 400);
    if (v === null || v === "") delete answers[k];
    else if (typeof v === "string" && ANSWER_RE.test(v)) answers[k] = v;
    else throw AppError.of("TAG_PLAN_INVALID", 400);
  }
  for (const [k, v] of Object.entries(notesIn || {})) {
    if (!KEY_RE.test(k)) throw AppError.of("TAG_PLAN_INVALID", 400);
    if (v === null || (typeof v === "string" && !v.trim())) delete notes[k];
    else if (typeof v === "string") notes[k] = v.trim().slice(0, NOTE_MAX);
    else throw AppError.of("TAG_PLAN_INVALID", 400);
  }
  if (Object.keys(answers).length > MAX_KEYS || Object.keys(notes).length > MAX_KEYS) throw AppError.of("TAG_PLAN_INVALID", 400);
  await AppSetting.findOneAndUpdate({ key: KEY }, { $set: { value: { answers, notes }, updatedBy: by } }, { upsert: true });
  return get();
}

module.exports = { get, set };
