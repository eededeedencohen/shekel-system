/**
 * @file Culture service — the ONLY write path for תרבות לכל
 *       (events, registrations + waitlist, attendance, vouchers)
 * @module services/cultureService
 *
 * The ERD's rules, enforced from every caller:
 *  - ACTORS are people. Creating/publishing an event, reporting attendance
 *    and handing out vouchers require an ACTIVE ManagerCulture profile;
 *    registering/cancelling is allowed to the student themself OR staff.
 *    (No auth yet: the client sends the acting person's id from the
 *    persona; the check is on the id, exactly like the ERD demands.)
 *  - REGISTRATION: only a published, future event; the student must hold an
 *    active StudentCulture profile in the same world; the event's
 *    settings (gender scope, age range) must fit — staff may `force`.
 *  - CAPACITY: registered < capacity, checked in a transaction; when full,
 *    the student joins the WAITLIST (position = last+1) unless told not to.
 *  - PROMOTION: a cancelled seat goes to the lowest waitlist position,
 *    with a "promoted" history entry; positions are renumbered.
 *  - ATTENDANCE: staff only, on registered seats, never before the event.
 *  - VOUCHERS: granted at most once (to a culture student), redeemed once.
 */

const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Voucher = require("../models/Voucher");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const { EVENT_GENDER_LABELS } = require("../utils/domain");

const LIVE = ["registered", "waitlisted"];

/* ───────────────────────── actors ───────────────────────── */

/** Active ManagerCulture profile of a person in a world, or null. */
function staffProfileOf(personId, world) {
  if (!personId) return null;
  return Profile.findOne({ person: personId, kind: "ManagerCulture", active: true, world });
}

/** Throw unless `personId` is culture staff in this world. */
async function assertStaff(personId, world) {
  if (!personId) throw AppError.of("NO_ACTOR", 400);
  const p = await staffProfileOf(personId, world);
  if (!p) throw AppError.of("NOT_CULTURE_STAFF", 403);
  return p;
}

/** The student themself or culture staff — returns "self" | "staff". */
async function assertActor({ actorId, world, studentId }) {
  if (!actorId) throw AppError.of("NO_ACTOR", 400);
  if (String(actorId) === String(studentId)) return "self";
  const p = await staffProfileOf(actorId, world);
  if (!p) throw AppError.of("NOT_CULTURE_STAFF", 403);
  return "staff";
}

/** Person + active StudentCulture profile, world-checked. */
async function assertCultureStudent(personId, world) {
  const person = await Person.findById(personId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "סטודנט/ית");
  if (person.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  const profile = await Profile.findOne({ person: person._id, kind: "StudentCulture", active: true });
  if (!profile) throw AppError.of("NOT_CULTURE_STUDENT", 400);
  return { person, profile };
}

async function requireEvent(eventId, world) {
  const event = await Event.findById(eventId);
  if (!event) throw AppError.of("NOT_FOUND", 404, "אירוע");
  if (event.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  return event;
}

/* ───────────────────────── events ───────────────────────── */

const EVENT_FIELDS = ["name", "date", "endTime", "category", "location", "description", "settings", "notes", "price", "import"];
const pickEvent = (data = {}) => {
  const out = {};
  for (const k of EVENT_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
};

async function createEvent({ world, by, data, at }) {
  await assertStaff(by, world);
  return Event.create({
    ...pickEvent(data),
    world,
    status: "draft",
    created: { by, at: at || new Date() },
  });
}

async function updateEvent({ eventId, world, by, data }) {
  await assertStaff(by, world);
  const event = await requireEvent(eventId, world);
  if (event.status === "cancelled") throw AppError.of("EVENT_NOT_OPEN", 400, "האירוע בוטל");
  Object.assign(event, pickEvent(data));
  return event.save();
}

async function publishEvent({ eventId, world, by, at }) {
  await assertStaff(by, world);
  const event = await requireEvent(eventId, world);
  if (event.status === "cancelled") throw AppError.of("EVENT_NOT_OPEN", 400, "האירוע בוטל");
  if (event.status === "published") return event;
  event.status = "published";
  event.published = { by, at: at || new Date() };
  return event.save();
}

/** Cancel the event and every live registration on it (with the reason). */
async function cancelEvent({ eventId, world, by, reason, at }) {
  await assertStaff(by, world);
  const event = await requireEvent(eventId, world);
  if (event.status === "cancelled") return { event, cancelled: 0 };
  const when = at || new Date();
  event.status = "cancelled";
  event.cancelledAt = when;
  await event.save();
  const live = await EventRegistration.find({ event: event._id, status: { $in: LIVE } });
  for (const r of live) {
    r.status = "cancelled";
    r.cancelledAt = when;
    r.waitlist = undefined;
    r.history.push({ action: "cancelled", at: when, by, reason: reason || "האירוע בוטל" });
    await r.save();
  }
  return { event, cancelled: live.length };
}

async function markEventDone({ eventId, world, by }) {
  await assertStaff(by, world);
  const event = await requireEvent(eventId, world);
  if (event.status !== "published") throw AppError.of("EVENT_NOT_OPEN", 400);
  event.status = "done";
  return event.save();
}

/** Only an untouched draft may be deleted — anything else is history. */
async function deleteEvent({ eventId, world, by }) {
  await assertStaff(by, world);
  const event = await requireEvent(eventId, world);
  const refs = await EventRegistration.countDocuments({ event: event._id });
  if (event.status !== "draft" || refs) throw AppError.of("REFERENCED_BLOCKED", 409);
  await event.deleteOne();
}

/* ─────────────────────── eligibility ─────────────────────── */

const ageAt = (birthDate, when) => {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  const d = when || new Date();
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age -= 1;
  return age;
};

/**
 * Why a person does NOT fit an event's settings — [] when they do.
 * Unknown facts (no gender / no birth date) are not held against them.
 */
function eligibilityIssues(event, person) {
  const s = event.settings || {};
  const issues = [];
  if (s.gender && s.gender !== "all" && person.gender) {
    const want = s.gender === "men" ? "male" : "female";
    if (person.gender !== want) issues.push(`האירוע ל${EVENT_GENDER_LABELS[s.gender]} בלבד`);
  }
  const age = ageAt(person.birthDate, event.date);
  if (age != null) {
    if (s.ageMin != null && age < s.ageMin) issues.push(`גיל ${age} — מתחת לגיל המינימלי ${s.ageMin}`);
    if (s.ageMax != null && age > s.ageMax) issues.push(`גיל ${age} — מעל לגיל המקסימלי ${s.ageMax}`);
  }
  return issues;
}

/* ─────────────────────── registrations ─────────────────────── */

function registeredCount(eventId, session) {
  return EventRegistration.countDocuments({ event: eventId, status: "registered" }, session ? { session } : undefined);
}

async function nextWaitlistPosition(eventId, session) {
  const last = await EventRegistration.findOne({ event: eventId, status: "waitlisted" })
    .sort({ "waitlist.position": -1 })
    .session(session || null);
  return (last?.waitlist?.position || 0) + 1;
}

/** Renumber the waitlist 1..n by current position (after removals). */
async function renumberWaitlist(eventId) {
  const queue = await EventRegistration.find({ event: eventId, status: "waitlisted" }).sort({
    "waitlist.position": 1,
    "waitlist.since": 1,
  });
  let pos = 1;
  for (const r of queue) {
    if (r.waitlist?.position !== pos) {
      r.waitlist.position = pos;
      await r.save();
    }
    pos++;
  }
}

/**
 * Give a freed seat to the head of the waitlist. Returns the promoted
 * registration or null (no queue / no seat / event not published).
 */
async function promoteNext(eventId, at) {
  const event = await Event.findById(eventId);
  if (!event || event.status !== "published") return null;
  const cap = event.settings?.capacity;
  if (cap != null && (await registeredCount(eventId)) >= cap) return null;
  const next = await EventRegistration.findOne({ event: eventId, status: "waitlisted" }).sort({
    "waitlist.position": 1,
    "waitlist.since": 1,
  });
  if (!next) return null;
  const when = at || new Date();
  next.status = "registered";
  next.registeredAt = when;
  next.waitlist = undefined;
  next.history.push({ action: "promoted", at: when, reason: "התפנה מקום" });
  await next.save();
  await renumberWaitlist(eventId);
  return next;
}

/** A person who is NOT a culture member — allowed on as a guest by staff. */
async function assertGuestPerson(personId, world) {
  const person = await Person.findById(personId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  if (person.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  return { person };
}

/**
 * Register a culture student to an event (seat or waitlist).
 *   { eventId, studentId, world, by, reason?, at?, force?, allowWaitlist?, guest?, trusted? }
 * `trusted` (seeds) skips the published/future checks so history can be
 * built; `force` (staff only) overrides the settings check; `guest` (staff
 * only) admits a person without a culture profile as אורח/ת.
 */
async function register({
  eventId, studentId, world, by, reason, at, force = false, allowWaitlist = true, guest = false, trusted = false,
}) {
  const event = await requireEvent(eventId, world);
  const actor = await assertActor({ actorId: by, world, studentId });
  if (guest && actor !== "staff") throw AppError.of("NOT_CULTURE_STAFF", 403);
  const { person } = guest ? await assertGuestPerson(studentId, world) : await assertCultureStudent(studentId, world);
  const when = at || new Date();

  if (!trusted) {
    if (event.status !== "published") throw AppError.of("EVENT_NOT_OPEN", 400);
    if (event.date.getTime() < Date.now()) throw AppError.of("EVENT_NOT_OPEN", 400, "האירוע כבר התקיים");
  }
  const issues = eligibilityIssues(event, person);
  if (issues.length && !(force && actor === "staff")) {
    throw AppError.of("NOT_ELIGIBLE", 400, issues.join("; "));
  }

  return withTxn(async (session) => {
    const opts = session ? { session } : {};
    const existing = await EventRegistration.findOne({ event: event._id, student: person._id }).session(session || null);
    if (existing && LIVE.includes(existing.status)) throw AppError.of("DUPLICATE_REGISTRATION", 409);

    const cap = event.settings?.capacity;
    const seatFree = cap == null || (await registeredCount(event._id, session)) < cap;
    if (!seatFree && !allowWaitlist) throw AppError.of("EVENT_FULL", 409);

    const status = seatFree ? "registered" : "waitlisted";
    const fields = {
      status,
      isGuest: !!guest,
      cancelledAt: null,
      ...(seatFree
        ? { registeredAt: when, waitlist: undefined }
        : { waitlist: { position: await nextWaitlistPosition(event._id, session), since: when, addedBy: by } }),
    };
    const entry = { action: status, at: when, by, reason };

    if (existing) {
      Object.assign(existing, fields);
      existing.history.push(entry);
      return existing.save(opts);
    }
    const [created] = await EventRegistration.create(
      [{ event: event._id, student: person._id, world: event.world, ...fields, history: [entry] }],
      opts
    );
    return created;
  });
}

/** Cancel a live registration; a freed seat promotes the waitlist head. */
async function cancelRegistration({ registrationId, world, by, reason, at }) {
  const reg = await EventRegistration.findById(registrationId);
  if (!reg) throw AppError.of("NOT_FOUND", 404, "רישום");
  if (reg.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (!LIVE.includes(reg.status)) throw AppError.of("REGISTRATION_CLOSED", 400);
  await assertActor({ actorId: by, world, studentId: reg.student });
  const when = at || new Date();
  const hadSeat = reg.status === "registered";
  reg.status = "cancelled";
  reg.cancelledAt = when;
  reg.waitlist = undefined;
  reg.history.push({ action: "cancelled", at: when, by, reason });
  await reg.save();

  let promoted = null;
  if (hadSeat) promoted = await promoteNext(reg.event, when);
  else await renumberWaitlist(reg.event);
  return { registration: reg, promoted };
}

/**
 * Report attendance on a registered seat (staff only, after the event).
 * `present: null` clears the report.
 */
async function reportAttendance({ registrationId, world, by, present, note, at, trusted = false }) {
  await assertStaff(by, world);
  const reg = await EventRegistration.findById(registrationId).populate({ path: "event", select: "date" });
  if (!reg) throw AppError.of("NOT_FOUND", 404, "רישום");
  if (reg.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (reg.status !== "registered") throw AppError.of("REGISTRATION_CLOSED", 400, "אפשר לדווח רק על רשומים");
  if (!trusted && reg.event?.date && reg.event.date.getTime() > Date.now()) {
    throw AppError.of("EVENT_NOT_HELD", 400);
  }
  const when = at || new Date();
  if (present === null) {
    reg.attendance = undefined;
  } else {
    reg.attendance = { present: !!present, note, reportedBy: by, reportedAt: when };
    reg.history.push({ action: present ? "attended" : "absent", at: when, by, reason: note });
  }
  reg.depopulate("event");
  return reg.save();
}

/* ───────────────────────── vouchers ───────────────────────── */

const VOUCHER_FIELDS = ["name", "number", "balance", "initialValue", "expiresAt", "notes"];
const pickVoucher = (data = {}) => {
  const out = {};
  for (const k of VOUCHER_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
};

async function requireVoucher(voucherId, world) {
  const v = await Voucher.findById(voucherId);
  if (!v) throw AppError.of("NOT_FOUND", 404, "שובר");
  if (v.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  return v;
}

async function createVoucher({ world, by, data }) {
  await assertStaff(by, world);
  const fields = pickVoucher(data);
  if (fields.balance == null && fields.initialValue != null) fields.balance = fields.initialValue;
  if (fields.initialValue == null && fields.balance != null) fields.initialValue = fields.balance;
  try {
    return await Voucher.create({ ...fields, world });
  } catch (e) {
    if (e.code === 11000) throw AppError.of("VOUCHER_NUMBER_TAKEN", 409, fields.number);
    throw e;
  }
}

async function updateVoucher({ voucherId, world, by, data }) {
  await assertStaff(by, world);
  const v = await requireVoucher(voucherId, world);
  Object.assign(v, pickVoucher(data));
  try {
    return await v.save();
  } catch (e) {
    if (e.code === 11000) throw AppError.of("VOUCHER_NUMBER_TAKEN", 409, v.number);
    throw e;
  }
}

/** Hand the voucher to a culture student (the ERD's "קיבל שובר"). */
async function grantVoucher({ voucherId, world, by, studentId, at, note }) {
  await assertStaff(by, world);
  const v = await requireVoucher(voucherId, world);
  if (v.grant) throw AppError.of("VOUCHER_TAKEN", 409);
  const { person } = await assertCultureStudent(studentId, world);
  v.grant = { student: person._id, by, at: at || new Date(), redeemed: false, note };
  return v.save();
}

async function redeemVoucher({ voucherId, world, by, at }) {
  await assertStaff(by, world);
  const v = await requireVoucher(voucherId, world);
  if (!v.grant) throw AppError.of("VOUCHER_NOT_GRANTED", 400);
  if (v.grant.redeemed) throw AppError.of("VOUCHER_REDEEMED", 400);
  v.grant.redeemed = true;
  v.grant.redeemedAt = at || new Date();
  return v.save();
}

/** Take back an un-redeemed grant (a mistake) — the voucher returns to stock. */
async function revokeGrant({ voucherId, world, by }) {
  await assertStaff(by, world);
  const v = await requireVoucher(voucherId, world);
  if (!v.grant) throw AppError.of("VOUCHER_NOT_GRANTED", 400);
  if (v.grant.redeemed) throw AppError.of("VOUCHER_REDEEMED", 400);
  v.grant = null;
  return v.save();
}

async function deleteVoucher({ voucherId, world, by }) {
  await assertStaff(by, world);
  const v = await requireVoucher(voucherId, world);
  if (v.grant) throw AppError.of("REFERENCED_BLOCKED", 409);
  await v.deleteOne();
}

module.exports = {
  // actors
  staffProfileOf, assertStaff, assertActor, assertCultureStudent,
  // events
  createEvent, updateEvent, publishEvent, cancelEvent, markEventDone, deleteEvent, eligibilityIssues,
  // registrations
  register, cancelRegistration, reportAttendance, promoteNext, renumberWaitlist, registeredCount,
  // vouchers
  createVoucher, updateVoucher, grantVoucher, redeemVoucher, revokeGrant, deleteVoucher,
};
