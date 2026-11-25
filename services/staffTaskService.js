/**
 * @file The tasks the super admin gives the staff (models/StaffTask)
 * @module services/staffTaskService
 *
 * Rules (Eden, 2026-11-25):
 *  - a task is GIVEN by the super admin ("אני כרגע יכול לתת משימות לעובדים
 *    האחרים"), to one person of the staff;
 *  - it is SEEN by the one who got it and by the super admin - nobody else
 *    ("כמובן שרק היא יכולה לצפות בנוסף אליי"); for anyone else it does not
 *    exist (404);
 *  - the two TALK on it ("צ'אט פרטי ביני לבין העובד"): `messages`, and for
 *    each of them how many came since they last looked (`unread`);
 *  - it is DONE when one of the two says so - or, for a task with a rule
 *    (`auto`), when the rule holds: nobody ticks such a task, it is read
 *    from the data every time the tasks are read (AUTO below).
 * "The super admin" is the ACTING one: viewing as someone, he is that someone.
 */

const mongoose = require("mongoose");
const StaffTask = require("../models/StaffTask");
const StaffAccount = require("../models/StaffAccount");
const WeekPlan = require("../models/WeekPlan");
const AppError = require("../utils/AppError");

const { TASK_AUTO_RULES } = StaffTask;
const clean = (v, max) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, max);
const line = (v, max) => clean(v, max).replace(/\s+/g, " ");
const idOfActor = (actor) => String(actor?._id || actor?.username || "");
const isSuper = (actor) => actor?.kind === "super";
const bad = () => AppError.of("TASK_INVALID", 400);

/**
 * The rules a task is done by on its own. Each answers `{ done, total, words }`: how far it is, and the noun that
 * is counted. The task is done when everything that is counted is done (and something is).
 */
const AUTO = {
  /** every lesson of the hostels teachers' week census has the staff's word on it (services/weekPlanService checkEntry) */
  async weekCensusChecked() {
    const plans = await WeekPlan.find().select("entries.check.state").lean();
    const entries = plans.flatMap((p) => p.entries || []);
    return { done: entries.filter((e) => e.check?.state).length, total: entries.length, words: "שיעורים סומנו" };
  },
};

/** An address inside the app, and nothing else: "/hostel-week?tab=week". */
function linkOf(v) {
  const to = clean(v, 200);
  if (!to) return "";
  if (!/^\/(?!\/)[\w\-./?=&%]*$/.test(to)) throw bad();
  return to;
}

/** Does this account see the task? The one who got it, and the super admin. */
const sees = (row, actor) => isSuper(actor) || row.assignee === idOfActor(actor);

/** The task as `actor` reads it; `auto` = the rule's answer, when the task has one. */
function view(row, actor, auto = null) {
  const me = idOfActor(actor);
  const seenAt = row.seen?.get?.(me) || null;
  const messages = (row.messages || []).map((m) => ({ _id: String(m._id), from: m.from, fromName: m.fromName || "", text: m.text, at: m.at }));
  return {
    _id: String(row._id),
    title: row.title,
    body: row.body || "",
    assignee: row.assignee,
    assigneeName: row.assigneeName || "",
    by: row.by,
    byName: row.byName || "",
    linkTo: row.linkTo || "",
    linkLabel: row.linkLabel || "",
    auto: row.auto ? { rule: row.auto, ...(auto || { done: 0, total: 0, words: "" }) } : null,
    done: !!row.done,
    doneAt: row.doneAt || null,
    doneBy: row.doneBy || "",
    messages,
    seenAt,
    // what the other one wrote since this account last looked
    unread: messages.filter((m) => m.from !== me && (!seenAt || new Date(m.at) > new Date(seenAt))).length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The rules' answers for these rows, each rule asked once - and a task whose rule turned is written as done (or open again). */
async function settleAuto(rows) {
  const rules = [...new Set(rows.map((r) => r.auto).filter((r) => r && AUTO[r]))];
  const answers = new Map();
  for (const r of rules) answers.set(r, await AUTO[r]());
  for (const row of rows) {
    const a = row.auto && answers.get(row.auto);
    if (!a) continue;
    const done = a.total > 0 && a.done >= a.total;
    if (done === !!row.done) continue;
    row.done = done;
    row.doneAt = done ? new Date() : null;
    row.doneBy = "";
    await StaffTask.updateOne({ _id: row._id }, { $set: { done: row.done, doneAt: row.doneAt, doneBy: "" } }, { timestamps: false });
  }
  return answers;
}

const shaped = async (row, actor) => view(row, actor, (await settleAuto([row])).get(row.auto));

/** The tasks this account sees: its own - and for the super admin, every task. What is still open stands first. */
async function list(actor) {
  const rows = await StaffTask.find(isSuper(actor) ? {} : { assignee: idOfActor(actor) }).sort({ createdAt: -1 });
  const answers = await settleAuto(rows);
  return rows.map((r) => view(r, actor, answers.get(r.auto))).sort((a, b) => Number(a.done) - Number(b.done));
}

async function load(id, actor) {
  const row = mongoose.isValidObjectId(id) ? await StaffTask.findById(id) : null;
  if (!row || !sees(row, actor)) throw AppError.of("NOT_FOUND", 404, "משימה");
  return row;
}
const onlySuper = (actor) => {
  if (!isSuper(actor)) throw AppError.of("AUTH_FORBIDDEN", 403);
};

/** A person of the staff a task can be given to (never a teacher's account). */
async function staffOf(id) {
  const a = mongoose.isValidObjectId(id) ? await StaffAccount.findOne({ _id: id, kind: { $ne: "teacher" }, active: { $ne: false } }).select("name").lean() : null;
  if (!a) throw bad();
  return a;
}

async function create({ title, body, assignee, linkTo, linkLabel, auto, actor }) {
  onlySuper(actor);
  const name = line(title, 160);
  if (!name) throw bad();
  if (auto != null && auto !== "" && !TASK_AUTO_RULES.includes(auto)) throw bad();
  const who = await staffOf(assignee);
  const to = linkOf(linkTo);
  const row = await StaffTask.create({
    title: name,
    body: clean(body, 4000),
    assignee: String(who._id),
    assigneeName: who.name || "",
    by: idOfActor(actor),
    byName: actor?.name || "",
    linkTo: to,
    linkLabel: to ? line(linkLabel, 80) : "",
    auto: auto || null,
    seen: { [idOfActor(actor)]: new Date() },
  });
  return shaped(row, actor);
}

/** The words of the task and its key - the super admin's to change. */
async function update({ id, title, body, linkTo, linkLabel, actor }) {
  onlySuper(actor);
  const row = await load(id, actor);
  if (title !== undefined) {
    const name = line(title, 160);
    if (!name) throw bad();
    row.title = name;
  }
  if (body !== undefined) row.body = clean(body, 4000);
  if (linkTo !== undefined) row.linkTo = linkOf(linkTo);
  if (linkLabel !== undefined) row.linkLabel = line(linkLabel, 80);
  if (!row.linkTo) row.linkLabel = "";
  await row.save();
  return shaped(row, actor);
}

/** Done, or open again - said by one of the two. A task with a rule is never ticked by hand. */
async function setDone({ id, done, actor }) {
  const row = await load(id, actor);
  if (row.auto) throw AppError.of("TASK_AUTO", 409);
  row.done = !!done;
  row.doneAt = row.done ? new Date() : null;
  row.doneBy = row.done ? actor?.name || "" : "";
  await row.save();
  return shaped(row, actor);
}

/** A line in the talk about the task. Writing is also looking. */
async function say({ id, text, actor }) {
  const row = await load(id, actor);
  const words = clean(text, 2000);
  if (!words) throw bad();
  const me = idOfActor(actor);
  row.messages.push({ from: me, fromName: actor?.name || "", text: words, at: new Date() });
  if (row.messages.length > 500) row.messages.splice(0, row.messages.length - 500);
  row.seen.set(me, new Date());
  await row.save();
  return shaped(row, actor);
}

/**
 * This account looked at the task now: what was written until now is not new to it any more - and a task it had
 * never looked at stops being "new" (the dashboard's notice under the greeting stands until this first look).
 * `viewing` = the super admin looking through this account's eyes ("צפה בתור"): that is not the account's own look,
 * so nothing is written - the answer alone reads as looked at, and the next read says again what the person has
 * not seen.
 */
async function look({ id, actor, viewing = false }) {
  const row = await load(id, actor);
  if (!viewing) await StaffTask.updateOne({ _id: row._id }, { $set: { [`seen.${idOfActor(actor)}`]: new Date() } }, { timestamps: false });
  row.seen.set(idOfActor(actor), new Date());
  return shaped(row, actor);
}

async function remove({ id, actor }) {
  onlySuper(actor);
  const row = await load(id, actor);
  await row.deleteOne();
}

module.exports = { list, create, update, setDone, say, look, remove, sees, AUTO, TASK_AUTO_RULES };
