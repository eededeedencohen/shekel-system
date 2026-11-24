/**
 * @file The waiting lists of מכללה לכל - a list per subject, a queue in each
 * @module services/waitListService
 *
 * Eden (2026-11-24): "יהיה תור לרשימות. סטודנט כמובן יוכל להיות בכמה
 * רשימות… במקרה שסטודנט משובץ לשאול אם להסיר אותו מהרשימות האחרות ומאיזה".
 *
 *   WaitList    a list (a subject of the system, or only a name)
 *   WaitEntry   one person waiting in one list - a person of the system, or
 *               only a name as it was written (nobody is made a student by
 *               standing in a list)
 *
 * The queue is `rank`, ascending: whoever enters stands last; a row moved
 * by hand keeps who moved it and why. A row never vanishes when it leaves
 * the queue: it is ended with a reason (placed here, placed through another
 * list, asked to leave, no answer, no longer relevant) and can be brought
 * back to where it stood. Only a row entered by mistake is deleted.
 *
 * Every write answers with the whole board (`board`), small as it is: the
 * page paints at once and then stands on the server's word.
 */

const mongoose = require("mongoose");
const WaitList = require("../models/WaitList");
const WaitEntry = require("../models/WaitEntry");
const { Person } = require("../models/Person");
const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const AppError = require("../utils/AppError");
const tags = require("./tagService");
const lens = require("./lensService");

const { WAIT_WANTS, WAIT_END_REASONS } = WaitEntry;
/** The reasons a person leaves by (the two "placed" ones are written by a placement alone). */
const LEAVE_REASONS = ["asked", "noAnswer", "irrelevant"];
const PROGRAM_TAGS = ["college", "culture", "hostels", "gym"];
/** How long a row that left the queue stays on the page's history. */
const HISTORY_DAYS = 365;

const isId = (v) => mongoose.isValidObjectId(v);
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const bad = (code = "WAIT_INVALID") => AppError.of(code, 400);
const by = (req) => req.actor?.name || req.account?.name || "";
/** The same name however it was typed: marks, quotes and dashes aside. */
const nameKey = (s) => String(s || "").replace(/[֑-ׇ"'׳״.\-־]/g, " ").replace(/\s+/g, " ").trim();
/** Who a row is about: the person, or the written name. */
const whoKey = (e) => (e.person ? `p:${e.person}` : `n:${nameKey(e.name)}`);
const whoCond = (e) => (e.person ? { person: e.person } : { person: null });
const sameWho = (a, b) => whoKey(a) === whoKey(b);

/* ───────────────────────── reading ───────────────────────── */

/** The whole board: the lists, whoever waits, and whoever left in the last year - each row with who it is about. */
async function board(req) {
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000);
  const [lists, rows] = await Promise.all([
    WaitList.find({ archivedAt: null }).sort({ order: 1, createdAt: 1 }).lean(),
    WaitEntry.find({ $or: [{ state: "waiting" }, { endedAt: { $gte: since } }] })
      .sort({ rank: 1, createdAt: 1 })
      .lean(),
  ]);
  const open = new Set(lists.map((l) => String(l._id)));
  const entries = rows.filter((e) => open.has(String(e.list)));
  const ids = [...new Set(entries.filter((e) => e.person).map((e) => String(e.person)))];
  const [people, held, mine] = await Promise.all([
    ids.length ? Person.find({ _id: { $in: ids }, deletedAt: null }).select("firstName lastName").lean() : [],
    tags.tagsByPerson(ids),
    lens.scopeOf(req).people(),
  ]);
  const byId = new Map(people.map((p) => [String(p._id), p]));
  for (const e of entries) {
    const p = e.person && byId.get(String(e.person));
    // a person of the system: the name as it stands today, the programs held, and whether this viewer may open the
    // person's page (a student of another program is known to exist, and no more)
    e.who = p
      ? {
          _id: p._id,
          firstName: p.firstName,
          lastName: p.lastName,
          programs: (held.get(String(p._id))?.tags || []).filter((k) => PROGRAM_TAGS.includes(k)),
          inScope: !mine || mine.has(String(p._id)),
        }
      : null;
    if (!p) e.person = null;
  }
  return { lists, entries };
}

/* ───────────────────────── the lists ───────────────────────── */

async function subjectOf(v) {
  if (v == null || v === "") return null;
  if (!isId(v) || !(await Subject.exists({ _id: v }))) throw bad();
  return v;
}

async function nameFree(name, except) {
  const taken = await WaitList.find({ archivedAt: null, ...(except && { _id: { $ne: except } }) })
    .select("name")
    .lean();
  if (taken.some((l) => nameKey(l.name) === nameKey(name))) throw AppError.of("WAIT_LIST_TWICE", 409);
}

async function createList(req) {
  const name = text(req.body?.name, 80);
  if (!name) throw bad();
  await nameFree(name);
  const last = await WaitList.findOne({ archivedAt: null }).sort({ order: -1 }).select("order").lean();
  await WaitList.create({ name, subject: await subjectOf(req.body.subject), note: text(req.body.note, 300), order: (last?.order ?? -1) + 1, createdBy: by(req) });
  return board(req);
}

async function loadList(id) {
  const list = isId(id) ? await WaitList.findOne({ _id: id, archivedAt: null }) : null;
  if (!list) throw AppError.of("NOT_FOUND", 404, "רשימת המתנה");
  return list;
}

async function updateList(req) {
  const list = await loadList(req.params.id);
  const body = req.body || {};
  if ("name" in body) {
    const name = text(body.name, 80);
    if (!name) throw bad();
    await nameFree(name, list._id);
    list.name = name;
  }
  if ("subject" in body) list.subject = await subjectOf(body.subject);
  if ("note" in body) list.note = text(body.note, 300);
  await list.save();
  return board(req);
}

/** A list with nobody waiting is taken off the page; its history stays in the table. */
async function removeList(req) {
  const list = await loadList(req.params.id);
  if (await WaitEntry.exists({ list: list._id, state: "waiting" })) throw AppError.of("WAIT_LIST_HAS_PEOPLE", 409);
  if (await WaitEntry.exists({ list: list._id })) {
    list.archivedAt = new Date();
    await list.save();
  } else await WaitList.deleteOne({ _id: list._id });
  return board(req);
}

/* ───────────────────────── the queue ───────────────────────── */

const queueOf = (listId) => WaitEntry.find({ list: listId, state: "waiting" }).sort({ rank: 1, createdAt: 1 });

/** Write the queue's ranks as it stands in `rows` (0, 1, 2…). */
async function rerank(rows) {
  const ops = rows.map((e, i) => (e.rank === i ? null : { updateOne: { filter: { _id: e._id }, update: { $set: { rank: i } } } })).filter(Boolean);
  if (ops.length) await WaitEntry.bulkWrite(ops);
}

async function lastRank(listId) {
  const last = await WaitEntry.findOne({ list: listId, state: "waiting" }).sort({ rank: -1 }).select("rank").lean();
  return (last?.rank ?? -1) + 1;
}

/** Is this who already waiting in the list? */
async function waitsIn(listId, who, except) {
  const rows = await WaitEntry.find({ list: listId, state: "waiting", ...whoCond(who), ...(except && { _id: { $ne: except } }) })
    .select("person name")
    .lean();
  return rows.some((r) => sameWho(r, who));
}

/** Every waiting row of the same who (the person, or the written name). */
async function rowsOfWho(who) {
  const rows = await WaitEntry.find({ state: "waiting", ...whoCond(who) });
  return rows.filter((r) => sameWho(r, who));
}

async function loadEntry(id) {
  const entry = isId(id) ? await WaitEntry.findById(id) : null;
  if (!entry) throw AppError.of("NOT_FOUND", 404, "רישום ברשימת המתנה");
  return entry;
}

/** A person of the system the viewer may put in a list: one of the viewer's own people. */
async function personFor(req, id) {
  await lens.assertPerson(req, id);
  const p = await Person.findOne({ _id: id, deletedAt: null }).select("firstName lastName").lean();
  if (!p) throw AppError.of("NOT_FOUND", 404, "אדם");
  return p;
}
const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ").trim();

async function addEntry(req) {
  const body = req.body || {};
  const list = await loadList(body.list);
  const who = { person: null, name: text(body.name, 120) };
  if (body.person) {
    const p = await personFor(req, body.person);
    who.person = p._id;
    who.name = fullName(p) || who.name;
  }
  if (!who.name) throw bad();
  if (await waitsIn(list._id, who)) throw AppError.of("WAIT_ENTRY_TWICE", 409);
  if (body.wants != null && !WAIT_WANTS.includes(body.wants)) throw bad();
  // how many courses the person wants is said once, and holds in every list the person waits in
  const others = await rowsOfWho(who);
  const wants = body.wants ?? others.find((r) => r.wants)?.wants ?? null;
  const fromSheet = body.source === "sheet";
  await WaitEntry.create({
    list: list._id,
    person: who.person,
    name: who.name,
    phone: text(body.phone, 40),
    note: text(body.note, 200),
    learning: !!body.learning,
    wants,
    rank: await lastRank(list._id),
    since: fromSheet ? null : new Date(),
    source: fromSheet ? "sheet" : "app",
    addedBy: by(req),
  });
  if (body.wants != null && others.length) await WaitEntry.updateMany({ _id: { $in: others.map((r) => r._id) } }, { $set: { wants } });
  return board(req);
}

async function updateEntry(req) {
  const entry = await loadEntry(req.params.id);
  if (entry.state !== "waiting") throw AppError.of("WAIT_ENTRY_ENDED", 409);
  const body = req.body || {};
  if ("note" in body) entry.note = text(body.note, 200);
  if ("phone" in body) entry.phone = text(body.phone, 40);
  if ("learning" in body) entry.learning = !!body.learning;

  // the written name of whoever is not in the system - in every list it stands in
  if ("name" in body && !entry.person) {
    const name = text(body.name, 120);
    if (!name) throw bad();
    const rows = await rowsOfWho(entry);
    for (const r of rows) {
      if (String(r._id) === String(entry._id)) continue;
      r.name = name;
      await r.save();
    }
    entry.name = name;
  }

  if ("wants" in body) {
    if (body.wants != null && !WAIT_WANTS.includes(body.wants)) throw bad();
    const rows = await rowsOfWho(entry);
    await WaitEntry.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { wants: body.wants ?? null } });
    entry.wants = body.wants ?? null;
  }

  // the name is a person of the system (or is not, after all) - in every list the name stands in
  if ("person" in body) {
    const rows = await rowsOfWho(entry);
    if (body.person) {
      const p = await personFor(req, body.person);
      for (const r of rows) if (await waitsIn(r.list, { person: p._id }, r._id)) throw AppError.of("WAIT_ENTRY_TWICE", 409);
      await WaitEntry.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { person: p._id } });
      entry.person = p._id;
    } else {
      await WaitEntry.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { person: null } });
      entry.person = null;
    }
  }

  // to another list (last in its queue), or to another place in this one
  const moving = "list" in body && String(body.list) !== String(entry.list);
  if (moving) {
    const to = await loadList(body.list);
    if (await waitsIn(to._id, entry, entry._id)) throw AppError.of("WAIT_ENTRY_TWICE", 409);
    const from = entry.list;
    entry.list = to._id;
    entry.rank = await lastRank(to._id);
    await entry.save();
    await rerank(await queueOf(from));
  } else await entry.save();

  if (Number.isInteger(body.at)) {
    const rows = (await queueOf(entry.list)).filter((r) => String(r._id) !== String(entry._id));
    const at = Math.max(0, Math.min(rows.length, body.at));
    rows.splice(at, 0, entry);
    await rerank(rows);
    if (!moving) await WaitEntry.updateOne({ _id: entry._id }, { $set: { moved: { at: new Date(), by: by(req), why: text(body.why, 200) } } });
  }
  return board(req);
}

/**
 * A row leaves the queue. `reason` "placed" may name the course, and may take the person's rows in OTHER lists along
 * (`also`: their ids - what the staff ticked when asked "מאילו רשימות להסיר").
 */
async function endEntry(req) {
  const entry = await loadEntry(req.params.id);
  if (entry.state !== "waiting") throw AppError.of("WAIT_ENTRY_ENDED", 409);
  const body = req.body || {};
  const reason = body.reason;
  if (reason !== "placed" && !LEAVE_REASONS.includes(reason)) throw bad();
  let course = null;
  if (reason === "placed" && body.course) {
    if (!isId(body.course) || !(await Cycle.exists({ _id: body.course }))) throw bad();
    course = body.course;
  }
  const also = new Set((Array.isArray(body.also) ? body.also : []).map(String));
  also.delete(String(entry._id));
  const mine = await rowsOfWho(entry);
  const others = mine.filter((r) => also.has(String(r._id)));
  // every row named must be a waiting row of this same person
  if (others.length !== also.size) throw bad();
  const now = new Date();
  const end = { endedAt: now, endedBy: by(req), endNote: text(body.note, 200) };
  await WaitEntry.updateOne({ _id: entry._id }, { $set: { ...end, state: reason === "placed" ? "placed" : "left", endReason: reason, course } });
  if (others.length) {
    await WaitEntry.updateMany({ _id: { $in: others.map((r) => r._id) } }, { $set: { ...end, state: "left", endReason: reason === "placed" ? "elsewhere" : reason, course } });
  }
  for (const listId of new Set([entry, ...others].map((r) => String(r.list)))) await rerank(await queueOf(listId));
  return board(req);
}

/** Back to the queue, where the row stood. */
async function backEntry(req) {
  const entry = await loadEntry(req.params.id);
  if (entry.state === "waiting") return board(req);
  await loadList(entry.list);
  if (await waitsIn(entry.list, entry, entry._id)) throw AppError.of("WAIT_ENTRY_TWICE", 409);
  const rows = await queueOf(entry.list);
  const at = Math.max(0, Math.min(rows.length, entry.rank));
  Object.assign(entry, { state: "waiting", endReason: null, endNote: "", endedAt: null, endedBy: "", course: null });
  await entry.save();
  rows.splice(at, 0, entry);
  await rerank(rows);
  return board(req);
}

/** A row entered by mistake: gone, with no history. */
async function removeEntry(req) {
  const entry = await loadEntry(req.params.id);
  await WaitEntry.deleteOne({ _id: entry._id });
  if (entry.state === "waiting") await rerank(await queueOf(entry.list));
  return board(req);
}

module.exports = { board, createList, updateList, removeList, addEntry, updateEntry, endEntry, backEntry, removeEntry, WAIT_WANTS, WAIT_END_REASONS, LEAVE_REASONS };
