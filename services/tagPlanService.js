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
 *
 * A third row, "oldStudents" (2026-11-25: "קח את רשימת כל הסטודנטים מכאן…
 * אל תדרוס לי נתונים קיימים אלא אני רוצה בעמוד התכנונים טאב חדש - הצלבות
 * סטודנטים"): the students list of the association's old system as it was
 * taken that day - a name, a mobile, the kind and the status there, where
 * the person lives - for the ideas page's cross-check tab. Again a picture,
 * not an import: no person of the app is made or changed from it.
 * Each row keeps the person's ID NUMBER too, and that number never leaves
 * this file: what is read back says only whether a row has one (`hasId`)
 * and which person of ours carries the same number (`idPerson`) - the
 * surest sign that two rows are one person.
 */

const AppSetting = require("../models/AppSetting");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { normalizeIsraeliId } = require("../utils/israeliId");

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

const OLD_KEY = "oldStudents";
const OLD_MAX = 5000;

/** One row of the old list as it is kept: what the cross-check reads, and the ID number for the match alone. */
function oldRow(r) {
  if (!isMap(r) || !text(r.name, 120)) throw AppError.of("TAG_PLAN_INVALID", 400);
  return {
    rid: text(String(r.rid ?? ""), 20),
    name: text(r.name, 120),
    idNumber: normalizeIsraeliId(r.idNumber),
    phone: text(r.phone, 30),
    type: text(r.type, 60),
    status: text(r.status, 80),
    residence: text(r.residence, 60),
    frame: text(r.frame, 120),
  };
}

/**
 * The old system's students list beside our people, or null when none was loaded:
 *   { source, takenAt, loadedAt, loadedBy, ourIds, rows: [{ rid, name, phone, type, status, residence, frame, hasId, idPerson }] }
 * `idPerson` = the person of ours with the same ID number; `ourIds` = how many of our people have a number at all.
 * No ID number is in the answer.
 */
async function getOldList() {
  const row = await AppSetting.findOne({ key: OLD_KEY }).lean();
  if (!row || !isMap(row.value) || !Array.isArray(row.value.rows)) return null;
  const ids = [...new Set(row.value.rows.map((r) => r.idNumber).filter(Boolean))];
  const ours = ids.length ? await Person.find({ idNumber: { $in: ids } }).select("+idNumber").lean() : [];
  const byId = new Map(ours.map((p) => [p.idNumber, String(p._id)]));
  const ourIds = await Person.countDocuments({ idNumber: { $type: "string" } });
  return {
    source: row.value.source || "",
    takenAt: row.value.takenAt || null,
    loadedAt: row.updatedAt || null,
    loadedBy: row.updatedBy || "",
    ourIds,
    rows: row.value.rows.map(({ idNumber, ...r }) => ({ ...r, hasId: Boolean(idNumber), idPerson: (idNumber && byId.get(idNumber)) || null })),
  };
}

/** Load the old list (the whole of it, replacing what was there): { source, takenAt, rows: [{ rid, name, idNumber, phone, type, status, residence, frame }] }. */
async function setOldList(body, by = "") {
  if (!isMap(body) || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > OLD_MAX) throw AppError.of("TAG_PLAN_INVALID", 400);
  const rows = body.rows.map(oldRow);
  const takenAt = body.takenAt && !Number.isNaN(new Date(body.takenAt).getTime()) ? new Date(body.takenAt).toISOString() : null;
  await AppSetting.findOneAndUpdate({ key: OLD_KEY }, { $set: { value: { source: text(body.source, 120), takenAt, rows }, updatedBy: by } }, { upsert: true });
  return getOldList();
}

/** Take the old list off (the tab says there is none). */
async function clearOldList() {
  await AppSetting.deleteOne({ key: OLD_KEY });
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

module.exports = { get, set, getSheet, setSheet, clearSheet, getOldList, setOldList, clearOldList };
