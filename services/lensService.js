/**
 * @file Lens service - what the ACTING persona may read and touch, row by row
 * @module services/lensService
 *
 * Eden (2026-10-18): "ייטענו לקונטקסט אך ורק הנתונים הרלוונטים לצפייה…
 * גם מטעמי אבטחה והרשאות". utils/auth requireFamily closes whole routers
 * to a persona's kinds; this service draws the line INSIDE the open ones -
 * which people, cycles, enrollments, lessons, intake files, record rows
 * and invoices a persona gets - mirroring the client's lens (PersonaContext
 * scope: studentInScope / courseInScope), so the two never disagree:
 *
 *   super, social   everything (program "both")
 *   manager         מכללה לכל: people with the college tag (now or once),
 *                   the teachers; cycles without a hostel
 *   hostels         הוסטלים: people with the hostels tag (now or once), the
 *                   hostel managers, the residents of a hostel, the members
 *                   of a hostel cycle, the teachers; hostel cycles only
 *   culture         תרבות לכל: people with the culture tag (now or once)
 *                   and the culture staff; no cycles at all
 *
 * Teachers are shared staff: both college lenses get them all (a window one
 * program marks on a teacher's week is the other program's business too -
 * controllers/personController checkAvailability).
 *
 * Reads NARROW the query (narrowPeople / narrowCycles / narrowByPerson /
 * narrowByCycle); single records and writes ASSERT (assertPerson /
 * assertCycle, or the router.param guards: 403 OUT_OF_SCOPE when the record
 * exists outside the lens, 404 when it does not exist at all); a new
 * belonging must be of the persona's own program (assertProfileKind /
 * assertProgramTag). The id sets are read once per request (scopeOf).
 */

const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const { PersonTag } = require("../models/PersonTag");
const { Profile } = require("../models/profiles");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const AppError = require("../utils/AppError");
const tags = require("./tagService");

const isId = (v) => mongoose.isValidObjectId(v);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const strs = (list) => list.map((x) => String(x));

/* ───────────────────────── the lens ───────────────────────── */

/**
 * The persona's lens - the same four cases as PersonaContext, plus `gym`:
 * the חדר כושר grant (2026-10-29, utils/auth hasFeature) adds the gym's
 * members to whatever the kind sees.
 */
function lensOf(actor) {
  const kind = actor?.kind || "super";
  const cultureOnly = kind === "culture";
  const collegeOnly = kind === "manager";
  const hostelsOnly = kind === "hostels";
  const all = !cultureOnly && !collegeOnly && !hostelsOnly;
  const gym = all || (Array.isArray(actor?.features) && actor.features.includes("gym"));
  return { kind, all, cultureOnly, collegeOnly, hostelsOnly, gym };
}

/** The condition on cycles (null = every cycle). */
function cycleCond(lens) {
  if (lens.all) return null;
  if (lens.hostelsOnly) return { hostel: { $ne: null } };
  if (lens.collegeOnly) return { hostel: null };
  return { _id: { $in: [] } }; // תרבות לכל has no courses
}

/** Is this cycle (a doc or { hostel }) the lens's? */
const cycleInLens = (lens, cycle) => lens.all || (lens.hostelsOnly ? !!cycle?.hostel : lens.collegeOnly ? !cycle?.hostel : false);

/** Ids of the people who hold - or once held - any of these tags. */
async function holdersOf(keys) {
  const map = await tags.tagMap();
  const ids = keys.map((k) => map.get(k)?._id).filter(Boolean);
  if (!ids.length) return [];
  return PersonTag.distinct("person", { tag: { $in: ids } });
}

/**
 * Ids of the people who hold - or held - a role, by its PROFILE kind. The
 * program tags are the truth of belonging (the client reads them), but a
 * role (teacher, culture staff, hostel manager) is what the client derives
 * from the profiles (`role` / `kinds`), and an older teacher may carry no
 * `teacher` tag at all - so a role is read from both.
 */
const roleHolders = (kinds) => Profile.distinct("person", { kind: { $in: kinds } });

/** The people of a lens as a Set of id strings (null = everyone). */
async function personIdsOf(lens) {
  if (lens.all) return null;
  // the חדר כושר grant: its members (now or once) join whatever the kind sees
  const gym = lens.gym ? await holdersOf(["gym"]) : [];
  if (lens.cultureOnly) {
    const [tagged, staff] = await Promise.all([holdersOf(["culture", "cultureStaff"]), roleHolders(["ManagerCulture"])]);
    return new Set(strs([...tagged, ...staff, ...gym]));
  }
  if (lens.collegeOnly) {
    const [tagged, teachers] = await Promise.all([holdersOf(["college", "teacher"]), roleHolders(["Teacher"])]);
    return new Set(strs([...tagged, ...teachers, ...gym]));
  }
  // the hostels: the tagged, the hostel managers, the teachers, whoever lives in a hostel, whoever sits in a hostel cycle
  const [tagged, staff, residents, hostelCycles] = await Promise.all([
    holdersOf(["hostels", "hostelManager", "teacher"]),
    roleHolders(["Teacher", "ManagerHostel"]),
    Profile.distinct("person", { kind: "StudentCollege", "residence.hostel": { $ne: null } }),
    Cycle.distinct("_id", { hostel: { $ne: null } }),
  ]);
  const members = hostelCycles.length ? await Enrollment.distinct("student", { cycle: { $in: hostelCycles } }) : [];
  return new Set(strs([...tagged, ...staff, ...residents, ...members, ...gym]));
}

/**
 * The request's scope, read lazily and once: `lens`, `people()` → Set of
 * person ids or null, `cycles()` → array of cycle id strings or null,
 * `cycleSet()` → the same as a Set.
 */
function scopeOf(req) {
  if (req._lensScope) return req._lensScope;
  const lens = lensOf(req.actor);
  let people = null;
  let cycles = null;
  const scope = {
    lens,
    people() {
      if (lens.all) return Promise.resolve(null);
      if (!people) people = personIdsOf(lens);
      return people;
    },
    cycles() {
      if (lens.all) return Promise.resolve(null);
      if (!cycles) cycles = Cycle.distinct("_id", cycleCond(lens)).then(strs);
      return cycles;
    },
    async cycleSet() {
      const list = await scope.cycles();
      return list ? new Set(list) : null;
    },
  };
  req._lensScope = scope;
  return scope;
}

/* ───────────────────────── narrowing reads ───────────────────────── */

/** A people query: `_id` becomes the lens's ids (intersected with an `$in` already there). */
async function narrowPeople(req, filter) {
  const ids = await scopeOf(req).people();
  if (!ids) return filter;
  let allowed = [...ids];
  const prev = filter._id && filter._id.$in;
  if (prev) {
    const keep = new Set(strs(prev));
    allowed = allowed.filter((id) => keep.has(id));
  }
  filter._id = { $in: allowed.map(oid) };
  return filter;
}

/** The Mongo value of a person field under the lens: a given person is kept only when in scope. */
function personCond(ids, person) {
  if (!ids) return person;
  if (person != null && !(typeof person === "object" && person.$in)) return ids.has(String(person)) ? person : { $in: [] };
  let allowed = [...ids];
  if (person && person.$in) {
    const keep = new Set(strs(person.$in));
    allowed = allowed.filter((id) => keep.has(id));
  }
  return { $in: allowed.map(oid) };
}

/** A query with a person field (intakes, activities, incidents, profiles) narrowed to the lens's people. */
async function narrowByPerson(req, filter, field = "person") {
  const ids = await scopeOf(req).people();
  if (!ids) return filter;
  filter[field] = personCond(ids, filter[field]);
  return filter;
}

/** A cycles query: the hostel / college side of the lens (a side asked for across the lens yields nothing). */
function narrowCycles(req, filter) {
  const cond = cycleCond(scopeOf(req).lens);
  if (!cond) return filter;
  if ("hostel" in filter && "hostel" in cond) {
    const asked = filter.hostel;
    const ok = cond.hostel === null ? asked === null : asked !== null;
    if (!ok) filter._id = { $in: [] };
    return filter;
  }
  return Object.assign(filter, cond);
}

/** A query with a cycle field (enrollments, lessons): a given cycle is checked, else the lens's cycles are the filter. */
async function narrowByCycle(req, filter, field = "cycle") {
  const scope = scopeOf(req);
  if (scope.lens.all) return filter;
  const given = filter[field];
  if (given != null && !(typeof given === "object" && given.$in)) {
    await assertCycle(req, given);
    return filter;
  }
  const ids = await scope.cycles();
  filter[field] = { $in: ids.map(oid) };
  return filter;
}

/* ───────────────────────── asserting one record ───────────────────────── */

const outOfScope = () => AppError.of("OUT_OF_SCOPE", 403);

/** The person must be in the lens (403), and exist (404); an id that is no id is a 404 at once (2026-10-27 - never a skipped check). */
async function assertPerson(req, id) {
  if (id == null) return;
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "אדם");
  const ids = await scopeOf(req).people();
  if (!ids || ids.has(String(id))) return;
  const exists = await Person.exists({ _id: id });
  if (!exists) throw AppError.of("NOT_FOUND", 404, "אדם");
  throw outOfScope();
}

/** The cycle must be on the lens's side (403), and exist (404); an id that is no id is a 404 at once. */
async function assertCycle(req, id) {
  if (id == null) return;
  if (!isId(id)) throw AppError.of("NOT_FOUND", 404, "מחזור");
  const { lens } = scopeOf(req);
  if (lens.all) return;
  const cycle = await Cycle.findOne({ _id: id }).select("hostel").lean();
  if (!cycle) throw AppError.of("NOT_FOUND", 404, "מחזור");
  if (!cycleInLens(lens, cycle)) throw outOfScope();
}

/**
 * A cycle body may not sit on the other side: the hostels lens needs a
 * hostel, the college lens none. On a create the hostel must be there for
 * the hostels lens; on an update only a `hostel` in the body is judged.
 */
function assertCycleBody(req, body = {}, { create = false } = {}) {
  const { lens } = scopeOf(req);
  if (lens.all) return;
  if (lens.cultureOnly) throw outOfScope();
  if (!create && !("hostel" in body)) return;
  if (lens.hostelsOnly && !body.hostel) throw outOfScope();
  if (lens.collegeOnly && body.hostel) throw outOfScope();
}

/* ───────────────────────── new belongings ───────────────────────── */

/** The profile kinds a lens may open, and the program tags it may give. */
const KINDS_BY_LENS = {
  collegeOnly: ["StudentCollege", "Teacher", "ManagerCollege"],
  hostelsOnly: ["StudentCollege", "Teacher", "ManagerHostel"],
  cultureOnly: ["StudentCulture", "ManagerCulture"],
};
const TAGS_BY_LENS = { collegeOnly: ["college"], hostelsOnly: ["hostels"], cultureOnly: ["culture"] };
const PROGRAM_TAG_KEYS = ["college", "culture", "hostels", "gym"];
const lensKey = (lens) => (lens.collegeOnly ? "collegeOnly" : lens.hostelsOnly ? "hostelsOnly" : lens.cultureOnly ? "cultureOnly" : null);

/** A new profile of this kind - the persona's own program only (a culture coordinator opens no college student). */
function assertProfileKind(req, kind) {
  const key = lensKey(scopeOf(req).lens);
  if (!key || !kind) return;
  if (!KINDS_BY_LENS[key].includes(kind)) throw outOfScope();
}

/** A program tag given or taken - the persona's own program only (role tags are not judged here); "gym" needs the grant. */
function assertProgramTag(req, tagKey) {
  const { lens } = scopeOf(req);
  if (!PROGRAM_TAG_KEYS.includes(tagKey)) return;
  if (tagKey === "gym") {
    if (!lens.gym) throw outOfScope();
    return;
  }
  const key = lensKey(lens);
  if (!key) return;
  if (!TAGS_BY_LENS[key].includes(tagKey)) throw outOfScope();
}

/* ───────────────────────── router.param guards ───────────────────────── */

/**
 * A router.param handler: `load(id, req)` names the record's person and/or
 * cycle (`{ person, cycle }`, or null when there is no such record - the
 * controller answers its own 404), and both must be in the lens.
 */
const guardParam = (load) => async (req, res, next, id) => {
  try {
    if (scopeOf(req).lens.all || !isId(id)) return next();
    const ref = await load(id, req);
    if (!ref) return next();
    if (ref.person !== undefined) await assertPerson(req, ref.person);
    if (ref.cycle !== undefined) await assertCycle(req, ref.cycle);
    return next();
  } catch (e) {
    return next(e);
  }
};
/** `:id` is a person. */
const guardPerson = guardParam((id) => ({ person: id }));
/** `:id` is a cycle. */
const guardCycle = guardParam((id) => ({ cycle: id }));
/** `:id` is a record of `Model` with a `person` field. */
const guardByPerson = (Model) =>
  guardParam(async (id, req) => {
    const row = await Model.findOne({ _id: id }).select("person").lean();
    return row && { person: row.person };
  });
/**
 * `:id` is a profile and the request WRITES: the profile's kind must be of
 * the persona's own program (2026-10-27, appendix A-3 - a person in two
 * programs: the college manager may not close the culture profile).
 */
const guardProfileKind = (Model) => async (req, res, next, id) => {
  try {
    if (req.method === "GET" || scopeOf(req).lens.all || !isId(id)) return next();
    const row = await Model.findOne({ _id: id }).select("kind").lean();
    if (row) assertProfileKind(req, row.kind);
    return next();
  } catch (e) {
    return next(e);
  }
};
/** `:id` is a record of `Model` with a `cycle` field. */
const guardByCycle = (Model) =>
  guardParam(async (id, req) => {
    const row = await Model.findOne({ _id: id }).select("cycle").lean();
    return row && { cycle: row.cycle };
  });

module.exports = {
  lensOf,
  cycleCond,
  cycleInLens,
  scopeOf,
  narrowPeople,
  narrowByPerson,
  narrowCycles,
  narrowByCycle,
  personCond,
  assertPerson,
  assertCycle,
  assertCycleBody,
  assertProfileKind,
  assertProgramTag,
  guardParam,
  guardPerson,
  guardProfileKind,
  guardCycle,
  guardByPerson,
  guardByCycle,
};
