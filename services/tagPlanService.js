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
 *
 * A second row, "waitSheet" (2026-11-24: "תעשה לי דוגמא שם… עם הנתונים שבאמת
 * יש לנועה"): the waiting lists of the staff's old sheet as they stand in
 * it - a subject, the names in their order, the note beside each - for the
 * model of the ideas page's waiting-lists tab. It holds REAL people's names,
 * so it lives here, behind the super admin's door, and never in the code:
 * the client's files are public and the repository is not the place for
 * people. It is a picture of the sheet, not an import: no person, no
 * student and no list of the app is made from it.
 */

const AppSetting = require("../models/AppSetting");
const AppError = require("../utils/AppError");

const KEY = "tagPlan";
const MAX_KEYS = 300;
const KEY_RE = /^[\w:.|-]{1,120}$/;
const ANSWER_RE = /^[\w-]{1,40}$/;
const NOTE_MAX = 800;

const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const SHEET_KEY = "waitSheet";
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
/** One row of a list: a name and the note written beside it. */
function sheetRows(rows) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 300) throw AppError.of("TAG_PLAN_INVALID", 400);
  return rows.map((r) => {
    if (!isMap(r) || typeof r.name !== "string" || !text(r.name, 120)) throw AppError.of("TAG_PLAN_INVALID", 400);
    return { name: text(r.name, 120), note: text(r.note, 200) };
  });
}

/** The old sheet's waiting lists, or null when none was loaded. */
async function getSheet() {
  const row = await AppSetting.findOne({ key: SHEET_KEY }).lean();
  if (!row || !isMap(row.value) || !Array.isArray(row.value.lists)) return null;
  return { title: row.value.title || "", lists: row.value.lists, loadedAt: row.updatedAt || null, loadedBy: row.updatedBy || "" };
}

/** Load the sheet (the whole of it, replacing what was there): { title, lists: [{ subject, waiting: [{ name, note }], existing: [...] }] }. */
async function setSheet(body, by = "") {
  if (!isMap(body) || !Array.isArray(body.lists) || !body.lists.length || body.lists.length > 60) throw AppError.of("TAG_PLAN_INVALID", 400);
  const lists = body.lists.map((l) => {
    if (!isMap(l) || !text(l.subject, 80)) throw AppError.of("TAG_PLAN_INVALID", 400);
    return { subject: text(l.subject, 80), waiting: sheetRows(l.waiting), existing: sheetRows(l.existing) };
  });
  await AppSetting.findOneAndUpdate({ key: SHEET_KEY }, { $set: { value: { title: text(body.title, 120), lists }, updatedBy: by } }, { upsert: true });
  return getSheet();
}

/** Take the sheet off (the model goes back to its invented people). */
async function clearSheet() {
  await AppSetting.deleteOne({ key: SHEET_KEY });
  return null;
}

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

module.exports = { get, set, getSheet, setSheet, clearSheet };
