/**
 * @file gymService - חדר כושר פרופיט: the members, their contracts, the signing page
 * @module services/gymService
 *
 * Eden (2026-10-29): the gym app moves into the system (project-files/specs/
 * gym-plan.html). A member is a person with the `gym` program tag and one
 * GymMembership row. The stage is read from the facts (stageOf): waiting →
 * sent (the staff pressed WhatsApp with the personal link) → signed (the
 * contract was signed on the public page). The membership status comes
 * after the signing, with the old app's transitions (domain
 * GYM_TRANSITIONS). Leaving the program closes the tag and sets `endedAt`;
 * the row and its contract stay, and adding the person again revives it.
 *
 * The signing page (/gym/sign/:token) is public: it shows the terms, the
 * name and phone the staff know, takes the name as signed, the ID number
 * (checked by its check digit), the phone and the signature, and puts the
 * signature PNG in the bucket under gym/<membership>/signature.png. The
 * token is the server's and never rides in the staff JSON - the link route
 * hands the whole address to whoever may send it.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const GymMembership = require("../models/GymMembership");
const { Person } = require("../models/Person");
const { MODEL_BY_KIND } = require("../models/profiles");
const tags = require("./tagService");
const lens = require("./lensService");
const storage = require("./storage");
const AppError = require("../utils/AppError");
const { linkAnswer } = require("../utils/publicUrl");
const { GYM_MEMBERSHIP_KEYS, GYM_TRANSITIONS } = require("../utils/domain");
const { isValidIsraeliId, normalizeIsraeliId } = require("../utils/israeliId");

const MAX_SIGNATURE_BYTES = 350 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PERSON_FIELDS = "firstName lastName phone gender";

const personName = (p) => (p ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "");
const clean = (s, max = 120) => String(s == null ? "" : s).trim().slice(0, max);
const phoneDigits = (p) => String(p || "").replace(/\D/g, "");
const isValidPhone = (p) => /^0\d{8,9}$/.test(phoneDigits(p));
/** "0501234567" → "050-1234567" (what the staff type everywhere else). */
const prettyPhone = (p) => {
  const d = phoneDigits(p);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return clean(p, 30);
};
const newInviteToken = () => crypto.randomBytes(16).toString("hex");

/** ממתין / נשלח קישור / חתום - never stored. */
const stageOf = (m) => (m.contract?.signedAt ? "signed" : m.linkSentAt ? "sent" : "waiting");

/** The staff's view of a row (the token never rides here). */
function view(m) {
  const person = m.person && typeof m.person === "object" ? m.person : null;
  const signed = Boolean(m.contract && m.contract.signedAt);
  return {
    _id: String(m._id),
    person: String(person ? person._id : m.person),
    personName: person ? personName(person) : undefined,
    phone: person ? person.phone || "" : undefined,
    gender: person ? person.gender || "" : undefined,
    stage: stageOf(m),
    membership: m.membership || null,
    membershipChangedAt: m.membershipChangedAt || null,
    linkSentAt: m.linkSentAt || null,
    contract: signed ? { signedAt: m.contract.signedAt, name: m.contract.name, idNumber: m.contract.idNumber, phone: m.contract.phone, hasSignature: Boolean(m.contract.signatureKey) } : null,
    notes: m.notes || "",
    endedAt: m.endedAt || null,
    source: m.source || {},
    log: m.log || [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

async function load(id) {
  const m = await GymMembership.findById(id).populate("person", PERSON_FIELDS).lean();
  if (!m) throw AppError.of("NOT_FOUND", 404, "חבר/ת חדר כושר");
  return view(m);
}

/** Every row the lens may see, newest first (the ended ones too - the page sorts them). */
async function list(req) {
  const filter = await lens.narrowByPerson(req, {});
  const rows = await GymMembership.find(filter).populate("person", PERSON_FIELDS).sort({ createdAt: -1 }).lean();
  return rows.map(view);
}

/**
 * A new person of the gym, made like a new resident (hostelReportService
 * createResident): identity, a bare student profile (so every student list
 * knows them), the `student` and `gym` tags - never the college tag.
 */
async function createGymPerson({ firstName, lastName = "", gender, phone, by }) {
  const name = clean(firstName, 80);
  if (!name) throw AppError.of("MISSING_FIELDS", 400, "firstName");
  if (phone && !isValidPhone(phone)) throw AppError.of("GYM_PHONE_INVALID", 400);
  const person = await Person.create({ firstName: name, lastName: clean(lastName, 80), ...(gender && ["male", "female"].includes(gender) && { gender }), ...(phone && { phone: prettyPhone(phone) }) });
  const profile = new MODEL_BY_KIND.StudentCollege({ person: person._id });
  profile.$locals.openedBy = by;
  await profile.save();
  await tags.give({ personId: person._id, key: "student", by });
  return person;
}

/**
 * Adds a person to the gym: an existing one (`person`) or a new one
 * (`firstName`…). An ended membership comes back to life instead of a
 * second row. → { membership, revived }
 */
async function add(req, { person, firstName, lastName, gender, phone, notes, by }) {
  lens.assertProgramTag(req, "gym"); // the grant (or the super admin)
  let personId;
  if (person) {
    await lens.assertPerson(req, person);
    const p = await Person.findOne({ _id: person, deletedAt: null }).select("_id").lean();
    if (!p) throw AppError.of("NOT_FOUND", 404, "אדם");
    personId = p._id;
  } else {
    personId = (await createGymPerson({ firstName, lastName, gender, phone, by }))._id;
  }
  const existing = await GymMembership.findOne({ person: personId });
  if (existing) {
    if (!existing.endedAt) throw AppError.of("GYM_EXISTS", 409);
    existing.endedAt = null;
    if (!existing.contract?.signedAt) existing.linkSentAt = null; // the link goes out again
    existing.log.push({ action: "revived", by });
    await existing.save();
    await tags.give({ personId, key: "gym", by, note: "חדר כושר" });
    return { membership: await load(existing._id), revived: true };
  }
  await tags.give({ personId, key: "gym", by, note: "חדר כושר" });
  const made = await GymMembership.create({ person: personId, inviteToken: newInviteToken(), notes: clean(notes, 2000), log: [{ action: "added", by }] });
  return { membership: await load(made._id), revived: false };
}

async function live(id) {
  const m = await GymMembership.findById(id);
  if (!m) throw AppError.of("NOT_FOUND", 404, "חבר/ת חדר כושר");
  return m;
}

/** Notes, and - once signed - a typo in the name or the ID number of the contract. */
async function update(id, { notes, contract, by }) {
  const m = await live(id);
  if (notes !== undefined) m.notes = clean(notes, 2000);
  if (contract && m.contract?.signedAt) {
    if (contract.name !== undefined) {
      const name = clean(contract.name, 120);
      if (name.length < 2) throw AppError.of("MISSING_FIELDS", 400, "name");
      m.contract.name = name;
    }
    if (contract.idNumber !== undefined) {
      if (!isValidIsraeliId(contract.idNumber)) throw AppError.of("GYM_ID_INVALID", 400);
      m.contract.idNumber = normalizeIsraeliId(contract.idNumber);
    }
  }
  m.log.push({ action: "edited", by });
  await m.save();
  return load(m._id);
}

/** The membership status - after the signing only, along the allowed transitions. */
async function setMembership(id, { membership, note, by }) {
  const m = await live(id);
  if (m.endedAt) throw AppError.of("GYM_LEFT", 400);
  if (!m.contract?.signedAt) throw AppError.of("GYM_NOT_SIGNED", 400);
  if (!GYM_MEMBERSHIP_KEYS.includes(membership)) throw AppError.of("GYM_TRANSITION", 400);
  if (membership !== m.membership) {
    const from = m.membership || "none";
    if (!GYM_TRANSITIONS[from].includes(membership)) throw AppError.of("GYM_TRANSITION", 400);
    m.membership = membership;
    m.membershipChangedAt = new Date();
    m.log.push({ action: "membership", by, note: clean(note, 300) || membership });
    await m.save();
  }
  return load(m._id);
}

/** The staff pressed WhatsApp with the link: the stage "נשלח קישור". */
async function markSent(id, by) {
  const m = await live(id);
  if (m.endedAt) throw AppError.of("GYM_LEFT", 400);
  if (!m.contract?.signedAt) {
    m.linkSentAt = new Date();
    m.log.push({ action: "linkSent", by });
    await m.save();
  }
  return load(m._id);
}

/** The personal signing link, whole - for whoever may send it. */
async function link(req, id) {
  const m = await GymMembership.findById(id).select("+inviteToken");
  if (!m) throw AppError.of("NOT_FOUND", 404, "חבר/ת חדר כושר");
  if (!m.inviteToken) {
    m.inviteToken = newInviteToken();
    await m.save();
  }
  const answer = linkAnswer(req, `/gym/sign/${m.inviteToken}`, m.inviteToken, null);
  answer.live = !m.endedAt && !m.contract?.signedAt;
  answer.signed = Boolean(m.contract?.signedAt);
  return answer;
}

/** A fresh token (the old link dies). */
async function renewLink(req, id, by) {
  const m = await GymMembership.findById(id).select("+inviteToken");
  if (!m) throw AppError.of("NOT_FOUND", 404, "חבר/ת חדר כושר");
  m.inviteToken = newInviteToken();
  m.log.push({ action: "linkRenewed", by });
  await m.save();
  return link(req, id);
}

/** Leaving the program: the tag closes, the row stays with its contract. */
async function remove(id, by) {
  const m = await live(id);
  if (!m.endedAt) {
    m.endedAt = new Date();
    m.log.push({ action: "left", by });
    await m.save();
    await tags.take({ personId: m.person, key: "gym", by, note: "הוסר/ה מחדר הכושר" });
  }
  return load(m._id);
}

/** A signed read of the signature PNG (60 seconds), or null. */
async function signatureUrl(m) {
  const key = m?.contract?.signatureKey;
  if (!key) return null;
  const signed = await storage.presignGet({ key, mime: "image/png", name: "signature.png", inline: true });
  return signed.url;
}

/* ───────── the public page ───────── */

async function byToken(token) {
  if (!TOKEN_RE.test(String(token || ""))) throw AppError.of("GYM_LINK_INVALID", 404);
  const m = await GymMembership.findOne({ inviteToken: token }).select("+inviteToken").populate("person", PERSON_FIELDS);
  if (!m || m.endedAt) throw AppError.of("GYM_LINK_INVALID", 404);
  return m;
}

/** What the signing page needs: the name and phone to prefill, or the signed contract. */
function publicView(m) {
  const signed = Boolean(m.contract?.signedAt);
  return {
    name: signed ? m.contract.name : personName(m.person),
    phone: signed ? m.contract.phone : m.person?.phone || "",
    gender: m.person?.gender || "",
    signed,
    signedAt: signed ? m.contract.signedAt : null,
    idNumber: signed ? m.contract.idNumber : "",
    hasSignature: signed && Boolean(m.contract.signatureKey),
  };
}

/** The signing itself: the facts as typed, the signature to the bucket. */
async function sign(token, { name, idNumber, phone, signature }) {
  const m = await byToken(token);
  if (m.contract?.signedAt) throw AppError.of("GYM_SIGNED_ALREADY", 409);
  const fullName = clean(name, 120);
  if (fullName.length < 2) throw AppError.of("MISSING_FIELDS", 400, "name");
  if (!isValidIsraeliId(idNumber)) throw AppError.of("GYM_ID_INVALID", 400);
  if (!isValidPhone(phone)) throw AppError.of("GYM_PHONE_INVALID", 400);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signature || ""));
  if (!match) throw AppError.of("GYM_SIGNATURE_REQUIRED", 400);
  const png = Buffer.from(match[1], "base64");
  if (png.length < 200 || png.length > MAX_SIGNATURE_BYTES) throw AppError.of("GYM_SIGNATURE_REQUIRED", 400);
  const key = `gym/${m._id}/signature.png`;
  await storage.putBuffer({ key, body: png, mime: "image/png" });
  m.contract = { signedAt: new Date(), name: fullName, idNumber: normalizeIsraeliId(idNumber), phone: prettyPhone(phone), signatureKey: key };
  m.log.push({ action: "signed", by: fullName });
  await m.save();
  // the person's phone, when the staff had none
  if (m.person && !m.person.phone) await Person.updateOne({ _id: m.person._id }, { phone: prettyPhone(phone) });
  return publicView(await byToken(token));
}

module.exports = { list, load, add, update, setMembership, markSent, link, renewLink, remove, signatureUrl, byToken, publicView, sign, stageOf, view, createGymPerson, isValidPhone, prettyPhone };
