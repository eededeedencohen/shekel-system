/**
 * @file Culture service - the ONLY write path for תרבות לכל
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
 *    active StudentCulture profile; the event's
 *    settings (gender scope, age range) must fit - staff may `force`.
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
const StoredFile = require("../models/StoredFile");
const storedFiles = require("./storedFiles");
const images = require("./voucherImageService");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const { EVENT_GENDER_LABELS } = require("../utils/domain");

const LIVE = ["registered", "waitlisted"];

/* ───────────────────────── actors ───────────────────────── */

/** Active ManagerCulture profile of a person, or null. */
function staffProfileOf(personId) {
  if (!personId) return null;
  return Profile.findOne({ person: personId, kind: "ManagerCulture", active: true });
}

/** Throw unless `personId` is culture staff. */
async function assertStaff(personId) {
  if (!personId) throw AppError.of("NO_ACTOR", 400);
  const p = await staffProfileOf(personId);
  if (!p) throw AppError.of("NOT_CULTURE_STAFF", 403);
  return p;
}

/** The student themself or culture staff - returns "self" | "staff". */
async function assertActor({ actorId, studentId }) {
  if (!actorId) throw AppError.of("NO_ACTOR", 400);
  if (String(actorId) === String(studentId)) return "self";
  const p = await staffProfileOf(actorId);
  if (!p) throw AppError.of("NOT_CULTURE_STAFF", 403);
  return "staff";
}

/** Person + active StudentCulture profile. */
async function assertCultureStudent(personId) {
  const person = await Person.findById(personId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "סטודנט/ית");
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  const profile = await Profile.findOne({ person: person._id, kind: "StudentCulture", active: true });
  if (!profile) throw AppError.of("NOT_CULTURE_STUDENT", 400);
  return { person, profile };
}

async function requireEvent(eventId) {
  const event = await Event.findById(eventId);
  if (!event) throw AppError.of("NOT_FOUND", 404, "אירוע");
  return event;
}

/* ───────────────────────── events ───────────────────────── */

const EVENT_FIELDS = ["name", "date", "endTime", "category", "location", "description", "settings", "notes", "price", "import"];
const pickEvent = (data = {}) => {
  const out = {};
  for (const k of EVENT_FIELDS) if (data[k] !== undefined) out[k] = data[k];
  return out;
};

async function createEvent({ by, data, at }) {
  await assertStaff(by);
  return Event.create({
    ...pickEvent(data),
    status: "draft",
    created: { by, at: at || new Date() },
  });
}

async function updateEvent({ eventId, by, data }) {
  await assertStaff(by);
  const event = await requireEvent(eventId);
  if (event.status === "cancelled") throw AppError.of("EVENT_NOT_OPEN", 400, "האירוע בוטל");
  Object.assign(event, pickEvent(data));
  return event.save();
}

async function publishEvent({ eventId, by, at }) {
  await assertStaff(by);
  const event = await requireEvent(eventId);
  if (event.status === "cancelled") throw AppError.of("EVENT_NOT_OPEN", 400, "האירוע בוטל");
  if (event.status === "published") return event;
  event.status = "published";
  event.published = { by, at: at || new Date() };
  return event.save();
}

/** Cancel the event and every live registration on it (with the reason). */
async function cancelEvent({ eventId, by, reason, at }) {
  await assertStaff(by);
  const event = await requireEvent(eventId);
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

async function markEventDone({ eventId, by }) {
  await assertStaff(by);
  const event = await requireEvent(eventId);
  if (event.status !== "published") throw AppError.of("EVENT_NOT_OPEN", 400);
  event.status = "done";
  return event.save();
}

/** Only an untouched draft may be deleted - anything else is history. */
/**
 * Delete a draft (Eden, 2026-10-12: "אי אפשר למחוק אירועים שפורסמו אלא רק
 * לבטל"). A published event - and anything with registrations - keeps its
 * history: it is cancelled, never deleted.
 */
async function deleteEvent({ eventId, by }) {
  await assertStaff(by);
  const event = await requireEvent(eventId);
  if (event.status !== "draft") throw AppError.of("EVENT_NOT_DRAFT", 409);
  const refs = await EventRegistration.countDocuments({ event: event._id });
  if (refs) throw AppError.of("REFERENCED_BLOCKED", 409);
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
 * Why a person does NOT fit an event's settings - [] when they do.
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
    if (s.ageMin != null && age < s.ageMin) issues.push(`גיל ${age} - מתחת לגיל המינימלי ${s.ageMin}`);
    if (s.ageMax != null && age > s.ageMax) issues.push(`גיל ${age} - מעל לגיל המקסימלי ${s.ageMax}`);
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

/** A person who is NOT a culture member - allowed on as a guest by staff. */
async function assertGuestPerson(personId) {
  const person = await Person.findById(personId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  return { person };
}

/**
 * Register a culture student to an event (seat or waitlist).
 *   { eventId, studentId, by, reason?, at?, force?, allowWaitlist?, guest?, trusted? }
 * `trusted` (seeds) skips the published/future checks so history can be
 * built; `force` (staff only) overrides the settings check; `guest` (staff
 * only) admits a person without a culture profile as אורח/ת.
 */
async function register({
  eventId, studentId, by, reason, at, force = false, allowWaitlist = true, guest = false, trusted = false,
}) {
  const event = await requireEvent(eventId);
  const actor = await assertActor({ actorId: by, studentId });
  if (guest && actor !== "staff") throw AppError.of("NOT_CULTURE_STAFF", 403);
  const { person } = guest ? await assertGuestPerson(studentId) : await assertCultureStudent(studentId);
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
      [{ event: event._id, student: person._id, ...fields, history: [entry] }],
      opts
    );
    return created;
  });
}

/** Cancel a live registration; a freed seat promotes the waitlist head. */
async function cancelRegistration({ registrationId, by, reason, at }) {
  const reg = await EventRegistration.findById(registrationId);
  if (!reg) throw AppError.of("NOT_FOUND", 404, "רישום");
  if (!LIVE.includes(reg.status)) throw AppError.of("REGISTRATION_CLOSED", 400);
  await assertActor({ actorId: by, studentId: reg.student });
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
async function reportAttendance({ registrationId, by, present, note, at, trusted = false }) {
  await assertStaff(by);
  const reg = await EventRegistration.findById(registrationId).populate({ path: "event", select: "date" });
  if (!reg) throw AppError.of("NOT_FOUND", 404, "רישום");
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

async function requireVoucher(voucherId) {
  const v = await Voucher.findById(voucherId);
  if (!v) throw AppError.of("NOT_FOUND", 404, "שובר");
  return v;
}

/* ── the picture of the place (Eden, 2026-10-13) ──
 * One stored file per PLACE, shared by its vouchers. A voucher's image is
 * chosen one of three ways: bytes uploaded from the form (`imageData`, a
 * data URL, + an optional `imageThumb`), a link on the web (`imageUrl` -
 * a picture, or a page with og:image; voucherImageService), or the image
 * another voucher already has (`imageFrom` = that voucher's id - no new
 * upload, the same file). The file goes when its last voucher goes.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_THUMB_BYTES = 256 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/pjpeg", "image/png", "image/x-png", "image/webp", "image/gif", "image/avif", "image/bmp"]);
const normMime = (m) => (m === "image/pjpeg" ? "image/jpeg" : m === "image/x-png" ? "image/png" : m);

/** "data:image/…;base64,…" → { mime, buffer } - or the typed error. */
function parseImageData(dataUrl, max = MAX_IMAGE_BYTES) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!m) throw AppError.of("VOUCHER_IMAGE_INVALID", 400);
  const mime = m[1].toLowerCase();
  if (!IMAGE_MIMES.has(mime)) throw AppError.of("VOUCHER_IMAGE_INVALID", 400);
  const buffer = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > max) throw AppError.of("VOUCHER_IMAGE_INVALID", 400);
  return { mime: normMime(mime), buffer };
}

/** The picture a voucher may carry (the bucket flow's check): the image types, ≤ 8MB. */
function acceptVoucherImage(mime) {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  if (!IMAGE_MIMES.has(m)) return null;
  const norm = normMime(m);
  return { mime: norm, ext: norm.replace("image/", "") };
}

/** The stored file id the body asks for (or undefined = no change / none). */
async function resolveVoucherImage(data = {}) {
  if (data.imageFrom) {
    const other = await Voucher.findOne({ _id: data.imageFrom }).select("image").lean();
    if (!other || !other.image) throw AppError.of("NOT_FOUND", 404, "תמונת השובר");
    return other.image;
  }
  // a picture uploaded straight to the bucket (fileService, family "culture") and confirmed
  if (data.imageFile) {
    const file = await StoredFile.findOne({ _id: data.imageFile, family: "culture", status: "ready" });
    if (!file) throw AppError.of("NOT_FOUND", 404, "תמונת השובר");
    if (!file.attachedAt) await storedFiles.markAttached(file);
    return file._id;
  }
  if (data.imageData) {
    const { mime, buffer } = parseImageData(data.imageData);
    const thumb = data.imageThumb ? parseImageData(data.imageThumb, MAX_THUMB_BYTES).buffer : undefined;
    const file = await StoredFile.create({ name: data.imageName || "תמונת השובר", mime, size: buffer.length, data: buffer, thumb, family: "culture", owner: { kind: "voucher" } });
    return file._id;
  }
  if (data.imageUrl) {
    const got = await images.fetchImage(String(data.imageUrl).trim());
    if (!got) throw AppError.of("VOUCHER_IMAGE_FETCH", 400);
    if (!IMAGE_MIMES.has(got.mime) || got.buffer.length > MAX_IMAGE_BYTES) throw AppError.of("VOUCHER_IMAGE_INVALID", 400);
    const file = await StoredFile.create({ name: data.imageName || got.from, mime: normMime(got.mime), size: got.buffer.length, data: got.buffer, family: "culture", owner: { kind: "voucher" } });
    return file._id;
  }
  return undefined;
}

/** Drop a stored file once no voucher points at it any more. */
async function releaseVoucherImage(fileId) {
  if (!fileId) return;
  const still = await Voucher.countDocuments({ image: fileId });
  if (!still) await storedFiles.destroy(fileId);
}

async function createVoucher({ by, data }) {
  await assertStaff(by);
  const fields = pickVoucher(data);
  if (fields.balance == null && fields.initialValue != null) fields.balance = fields.initialValue;
  if (fields.initialValue == null && fields.balance != null) fields.initialValue = fields.balance;
  const image = await resolveVoucherImage(data);
  try {
    return await Voucher.create({ ...fields, ...(image && { image }) });
  } catch (e) {
    // a fresh upload that found no voucher to belong to
    if (image && !data.imageFrom) await storedFiles.destroy(image).catch(() => {});
    if (e.code === 11000) throw AppError.of("VOUCHER_NUMBER_TAKEN", 409, fields.number);
    throw e;
  }
}

/** Set / replace / remove the picture of an existing voucher (`remove: true`). */
async function setVoucherImage({ voucherId, by, data = {} }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  const before = v.image;
  if (data.remove) {
    if (!before) return v;
    v.image = null;
  } else {
    const image = await resolveVoucherImage(data);
    if (!image) throw AppError.of("MISSING_FIELDS", 400, "imageData | imageUrl | imageFrom");
    if (String(image) === String(before)) return v;
    v.image = image;
  }
  await v.save();
  await releaseVoucherImage(before);
  return v;
}

/** A picture uploaded straight to the bucket for an EXISTING voucher (fileService; the culture family gate already passed). */
async function setVoucherImageFile({ voucherId, fileId }) {
  const v = await requireVoucher(voucherId);
  const before = v.image;
  const image = await resolveVoucherImage({ imageFile: fileId });
  if (String(image) === String(before)) return v;
  v.image = image;
  await v.save();
  await releaseVoucherImage(before);
  return v;
}

/** The bytes of a voucher's picture: the small JPEG when asked for and there is one, else the file. */
async function voucherImageOf(voucherId, wantThumb) {
  const v = await Voucher.findOne({ _id: voucherId }).select("image").lean();
  if (!v || !v.image) return null;
  const file = await StoredFile.findById(v.image).select(wantThumb ? "mime thumb data updatedAt" : "mime data updatedAt");
  if (!file) return null;
  const thumb = wantThumb && file.thumb && file.thumb.length ? file.thumb : null;
  return { mime: thumb ? "image/jpeg" : file.mime, data: thumb || file.data, tag: `${file._id}-${new Date(file.updatedAt).getTime()}${thumb ? "-t" : ""}` };
}

/** Pictures on the web for a place name (voucherImageService). */
const searchVoucherImages = (q) => images.searchImages(q);

async function updateVoucher({ voucherId, by, data }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  Object.assign(v, pickVoucher(data));
  try {
    return await v.save();
  } catch (e) {
    if (e.code === 11000) throw AppError.of("VOUCHER_NUMBER_TAKEN", 409, v.number);
    throw e;
  }
}

/** Hand the voucher to a culture student (the ERD's "קיבל שובר"). */
async function grantVoucher({ voucherId, by, studentId, at, note }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  if (v.grant) throw AppError.of("VOUCHER_TAKEN", 409);
  const { person } = await assertCultureStudent(studentId);
  v.grant = { student: person._id, by, at: at || new Date(), redeemed: false, note };
  return v.save();
}

async function redeemVoucher({ voucherId, by, at }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  if (!v.grant) throw AppError.of("VOUCHER_NOT_GRANTED", 400);
  if (v.grant.redeemed) throw AppError.of("VOUCHER_REDEEMED", 400);
  v.grant.redeemed = true;
  v.grant.redeemedAt = at || new Date();
  return v.save();
}

/** Take back an un-redeemed grant (a mistake) - the voucher returns to stock. */
async function revokeGrant({ voucherId, by }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  if (!v.grant) throw AppError.of("VOUCHER_NOT_GRANTED", 400);
  if (v.grant.redeemed) throw AppError.of("VOUCHER_REDEEMED", 400);
  v.grant = null;
  return v.save();
}

async function deleteVoucher({ voucherId, by }) {
  await assertStaff(by);
  const v = await requireVoucher(voucherId);
  if (v.grant) throw AppError.of("REFERENCED_BLOCKED", 409);
  const image = v.image;
  await v.deleteOne();
  await releaseVoucherImage(image);
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
  setVoucherImage, setVoucherImageFile, voucherImageOf, searchVoucherImages, acceptVoucherImage,
};
