/**
 * @file Tag service - the catalog of belongings and who holds what
 * @module services/tagService
 *
 * The seed catalog (two groups, ten tags) is written once by
 * ensureCatalog(); after that the tables are the truth and a new tag is
 * a row. give / take / reopen are the only writers of personTags, and
 * every change leaves a row in personTagEvents.
 *
 * Reads for the API: tagsByPerson() → Map personId → { tags: [keys open
 * now], pastTags: [keys once held] }; tagsByCycle() → Map cycleId → [keys].
 */

const { Tag, TagGroup } = require("../models/Tag");
const { PersonTag, PersonTagEvent } = require("../models/PersonTag");
const CycleTag = require("../models/CycleTag");
const AppError = require("../utils/AppError");

/** The groups and tags the catalog starts with. A new one = a new line here or a row in the table. */
const CATALOG = {
  groups: [
    { key: "role", label: "תפקיד" },
    { key: "program", label: "תוכנית" },
  ],
  tags: [
    { group: "role", key: "student", label: "סטודנט/ית" },
    { group: "role", key: "teacher", label: "מורה" },
    { group: "role", key: "collegeManager", label: "מנהל/ת מכללה לכל" },
    { group: "role", key: "cultureStaff", label: "צוות תרבות לכל" },
    { group: "role", key: "hostelManager", label: "מנהל/ת הוסטל" },
    { group: "role", key: "socialWorker", label: "עובד/ת סוציאלי/ת" },
    { group: "role", key: "admin", label: "מנהל/ת מערכת" },
    { group: "program", key: "college", label: "מכללה לכל" },
    { group: "program", key: "culture", label: "תרבות לכל" },
    { group: "program", key: "hostels", label: "הוסטלים" },
    // חדר כושר פרופיט (2026-10-29): the gym app's members, a program like the hostels
    { group: "program", key: "gym", label: "חדר כושר" },
  ],
};

/** The old profile kinds → the tags they mean (the bridge, for the migration and the compat view). */
const KIND_TAGS = {
  StudentCollege: ["student", "college"],
  StudentCulture: ["student", "culture"],
  Teacher: ["teacher"],
  ManagerCollege: ["collegeManager"],
  ManagerCulture: ["cultureStaff"],
  ManagerHostel: ["hostelManager"],
  SocialWorker: ["socialWorker"],
  Admin: ["admin"],
};
/** The program tag of a student kind. */
const PROGRAM_OF_KIND = { StudentCollege: "college", StudentCulture: "culture" };

/** Write the catalog (idempotent). Returns Map key → tag doc. */
async function ensureCatalog() {
  const groups = new Map();
  for (const g of CATALOG.groups) {
    const doc = await TagGroup.findOneAndUpdate({ key: g.key }, { $setOnInsert: { key: g.key, label: g.label } }, { upsert: true, new: true });
    groups.set(g.key, doc);
  }
  const tags = new Map();
  for (const t of CATALOG.tags) {
    const doc = await Tag.findOneAndUpdate(
      { key: t.key },
      { $setOnInsert: { key: t.key, label: t.label, group: groups.get(t.group)._id, active: true } },
      { upsert: true, new: true }
    );
    tags.set(t.key, doc);
  }
  return tags;
}

/** key → tag (the catalog written if missing). */
async function tagMap() {
  const tags = await Tag.find().lean();
  if (tags.length < CATALOG.tags.length) return ensureCatalog();
  return new Map(tags.map((t) => [t.key, t]));
}

async function tagByKey(key) {
  const tag = (await tagMap()).get(key);
  if (!tag) throw AppError.of("TAG_UNKNOWN", 400, key);
  return tag;
}

/** The whole catalog, for GET /api/tags. */
async function catalog() {
  await tagMap();
  const [groups, tags] = await Promise.all([TagGroup.find().sort({ _id: 1 }).lean(), Tag.find().sort({ _id: 1 }).lean()]);
  const groupKey = new Map(groups.map((g) => [String(g._id), g.key]));
  return {
    groups: groups.map((g) => ({ key: g.key, label: g.label })),
    tags: tags.map((t) => ({ key: t.key, label: t.label, group: groupKey.get(String(t.group)), active: t.active !== false })),
  };
}

/* ───────── who holds what ───────── */

async function tagsByPerson(personIds) {
  const ids = [...new Set(personIds.map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows, keys] = await Promise.all([PersonTag.find({ person: { $in: ids } }).lean(), tagMap()]);
  const keyOfTag = new Map([...keys.values()].map((t) => [String(t._id), t.key]));
  for (const r of rows) {
    const k = String(r.person);
    if (!out.has(k)) out.set(k, { tags: [], pastTags: [] });
    const key = keyOfTag.get(String(r.tag));
    if (!key) continue;
    (r.until ? out.get(k).pastTags : out.get(k).tags).push(key);
  }
  for (const v of out.values()) v.pastTags = v.pastTags.filter((k) => !v.tags.includes(k));
  return out;
}

async function tagsByCycle(cycleIds) {
  const ids = [...new Set(cycleIds.map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const [rows, keys] = await Promise.all([CycleTag.find({ cycle: { $in: ids } }).lean(), tagMap()]);
  const keyOfTag = new Map([...keys.values()].map((t) => [String(t._id), t.key]));
  for (const r of rows) {
    const k = String(r.cycle);
    if (!out.has(k)) out.set(k, []);
    const key = keyOfTag.get(String(r.tag));
    if (key) out.get(k).push(key);
  }
  return out;
}

/** Plain person objects + their `tags` / `pastTags` (keys). */
async function attachPersonTags(people) {
  const list = Array.isArray(people) ? people : [people];
  const map = await tagsByPerson(list.map((p) => p._id));
  for (const p of list) {
    const t = map.get(String(p._id)) || { tags: [], pastTags: [] };
    p.tags = t.tags;
    p.pastTags = t.pastTags;
  }
  return people;
}

/** Cycles (docs or plain) → plain objects with `tags` and `program` ("college" | "hostels" | null). */
async function attachCycleTags(cycles) {
  const one = !Array.isArray(cycles);
  const list = (one ? [cycles] : cycles).map((c) => (c && c.toObject ? c.toObject() : c));
  const map = await tagsByCycle(list.filter(Boolean).map((c) => c._id));
  for (const c of list) {
    if (!c) continue;
    c.tags = map.get(String(c._id)) || [];
    c.program = c.tags.find((k) => k === "college" || k === "hostels") || null;
  }
  return one ? list[0] : list;
}

/* ───────── the writers ───────── */

/** A person gets a tag (opened, or reopened if they held it before). No-op when open already. */
async function give({ personId, key, at, by, note, otherKey }) {
  const tag = await tagByKey(key);
  const when = at ? new Date(at) : new Date();
  const otherTag = otherKey ? (await tagByKey(otherKey))._id : null;
  let row = await PersonTag.findOne({ person: personId, tag: tag._id });
  if (row && !row.until) return row;
  const event = row ? (otherKey ? "transferredIn" : "reopened") : otherKey ? "transferredIn" : "opened";
  if (row) {
    row.since = when;
    row.until = null;
    await row.save();
  } else {
    row = await PersonTag.create({ person: personId, tag: tag._id, since: when, until: null });
  }
  await PersonTagEvent.create({ personTag: row._id, event, at: when, by, note, otherTag });
  return row;
}

/** A person loses a tag (closed, or transferredOut when `otherKey` says where to). No-op when not held. */
async function take({ personId, key, at, by, note, otherKey }) {
  const tag = await tagByKey(key);
  const row = await PersonTag.findOne({ person: personId, tag: tag._id });
  if (!row || row.until) return row || null;
  const when = at ? new Date(at) : new Date();
  row.until = when;
  await row.save();
  const otherTag = otherKey ? (await tagByKey(otherKey))._id : null;
  await PersonTagEvent.create({ personTag: row._id, event: otherKey ? "transferredOut" : "closed", at: when, by, note, otherTag });
  return row;
}

/** Does the person hold the tag now? */
async function holds(personId, key) {
  const tag = (await tagMap()).get(key);
  if (!tag) return false;
  return !!(await PersonTag.exists({ person: personId, tag: tag._id, until: null }));
}

/** Set the program tag of a cycle (one of college | hostels), replacing the other. */
async function setCycleProgram({ cycleId, key }) {
  const tags = await tagMap();
  const tag = tags.get(key);
  if (!tag) throw AppError.of("TAG_UNKNOWN", 400, key);
  const other = tags.get(key === "college" ? "hostels" : "college");
  await CycleTag.deleteMany({ cycle: cycleId, tag: other._id });
  await CycleTag.updateOne({ cycle: cycleId, tag: tag._id }, { $setOnInsert: { cycle: cycleId, tag: tag._id } }, { upsert: true });
}

module.exports = {
  CATALOG,
  KIND_TAGS,
  PROGRAM_OF_KIND,
  ensureCatalog,
  tagMap,
  catalog,
  tagsByPerson,
  tagsByCycle,
  attachPersonTags,
  attachCycleTags,
  give,
  take,
  holds,
  setCycleProgram,
};
