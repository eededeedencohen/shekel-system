/**
 * @file Supplier service - פתיחת תיק ספק, from the link to the mail
 * @module services/supplierService
 *
 * The one place that moves a supplier (Eden, 2026-10-14). Two sides:
 *
 *   the coordinator (staff API)  create · link · review · mail steps
 *   the supplier (public API)    the view behind the link · the form ·
 *                                the files (upload / remove / "לא רלוונטי")
 *
 * The status is never set by hand - `computeStatus` reads the facts:
 *   link → filling → review → approved → done
 * A file or the form the coordinator marked לא תקין sends the supplier
 * back to `filling`; fixing it resets that item to `pending` and leaves an
 * unseen update for the coordinator's card.
 */

const crypto = require("crypto");
const Supplier = require("../models/Supplier");
const StoredFile = require("../models/StoredFile");
const AppError = require("../utils/AppError");
const {
  SUPPLIER_GENDER_KEYS,
  SUPPLIER_LINK_DAYS,
  SUPPLIER_FILES,
  SUPPLIER_FIELDS,
  SUPPLIER_FIELD_KEYS,
  SUPPLIER_PAYMENT_TERMS,
  SUPPLIER_STATUS_LABELS,
} = require("../utils/domain");
// the same file rules as the intake documents: PDF / images / Word, ≤ 8MB
const { fileKind, MAX_FILE_BYTES, INLINE_MIMES } = require("./intakeService");

const FILE_BY_KEY = Object.fromEntries(SUPPLIER_FILES.map((f) => [f.key, f]));
const FIELD_BY_KEY = Object.fromEntries(SUPPLIER_FIELDS.map((f) => [f.key, f]));
const LINK_DAY_KEYS = SUPPLIER_LINK_DAYS.map((d) => d.key);
const DAY_MS = 24 * 3600 * 1000;

const clean = (s, max = 200) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);
const digits = (s) => String(s || "").replace(/\D/g, "");
const makeToken = () => crypto.randomBytes(18).toString("base64url");

/* ───────────────────────── the facts ───────────────────────── */

const rowOf = (s, key) => (s.files || []).find((r) => r.key === key);
/** The supplier did this row: a file, or "does not apply" on the optional one. */
const rowDone = (r) => !!(r?.file?.stored || r?.notApplicable);
const rowOk = (r) => rowDone(r) && r.review?.state === "ok";
const rowBad = (r) => r?.review?.state === "bad";

/** Every certificate is in (the optional one uploaded or waved). */
function filesComplete(s) {
  return SUPPLIER_FILES.every((f) => rowDone(rowOf(s, f.key)));
}

/** How many of the four rows are done / ok / bad - the card's tags. */
function fileCounts(s) {
  const rows = SUPPLIER_FILES.map((f) => rowOf(s, f.key));
  return {
    total: SUPPLIER_FILES.length,
    done: rows.filter(rowDone).length,
    ok: rows.filter(rowOk).length,
    bad: rows.filter(rowBad).length,
  };
}

function computeStatus(s) {
  if (s.email?.sentAt) return "done";
  if (!s.formSubmittedAt) return "link";
  const anyBad = s.formReview?.state === "bad" || (s.files || []).some(rowBad);
  if (anyBad || !filesComplete(s)) return "filling";
  const allOk = s.formReview?.state === "ok" && SUPPLIER_FILES.every((f) => rowOk(rowOf(s, f.key)));
  return allOk ? "approved" : "review";
}

/** Recompute the status and save. */
async function settle(s) {
  s.status = computeStatus(s);
  await s.save();
  return s;
}

const unseenCount = (s) => (s.updates || []).filter((u) => !u.seenAt).length;

/* ───────────────────────── the coordinator's side ───────────────────────── */

function parseDays(days) {
  const n = Number(days);
  if (!LINK_DAY_KEYS.includes(n)) throw AppError.of("SUPPLIER_LINK_DAYS_INVALID", 400);
  return n;
}

/** A new supplier with a fresh link. */
async function create({ world, body = {}, by }) {
  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const gender = SUPPLIER_GENDER_KEYS.includes(body.gender) ? body.gender : null;
  const phone = clean(body.phone, 30);
  if (!firstName || !lastName || !gender || digits(phone).length < 9) throw AppError.of("SUPPLIER_INVALID", 400);
  const days = parseDays(body.days ?? 7);
  const s = new Supplier({
    world,
    firstName,
    lastName,
    gender,
    phone,
    createdBy: by,
    link: { token: makeToken(), expiresAt: new Date(Date.now() + days * DAY_MS), days, createdAt: new Date(), by },
  });
  return settle(s);
}

/** The name / gender / phone - what the coordinator typed first. */
async function updateDetails(s, body = {}) {
  if ("firstName" in body) s.firstName = clean(body.firstName, 60) || s.firstName;
  if ("lastName" in body) s.lastName = clean(body.lastName, 60) || s.lastName;
  if ("gender" in body && SUPPLIER_GENDER_KEYS.includes(body.gender)) s.gender = body.gender;
  if ("phone" in body && digits(body.phone).length >= 9) s.phone = clean(body.phone, 30);
  return settle(s);
}

/**
 * Open the link again for `days` from now. `fresh` makes a new token (the
 * old message stops working); by default the same address is extended, so
 * a message already sent keeps working.
 */
async function renewLink(s, { days, fresh = false, by }) {
  if (s.email?.sentAt) throw AppError.of("SUPPLIER_DONE", 400);
  const n = parseDays(days ?? s.link?.days ?? 7);
  s.link = {
    ...(s.link?.toObject ? s.link.toObject() : s.link),
    token: fresh || !s.link?.token ? makeToken() : s.link.token,
    expiresAt: new Date(Date.now() + n * DAY_MS),
    days: n,
    createdAt: new Date(),
    by,
  };
  return settle(s);
}

/**
 * The coordinator's verdict on one item: `target` = "form" or a file key.
 * לא תקין needs a note; a bad form needs the fields that are wrong.
 */
async function review(s, { target, state, note, fields, by }) {
  if (s.email?.sentAt) throw AppError.of("SUPPLIER_DONE", 400);
  if (!["ok", "bad"].includes(state)) throw AppError.of("SUPPLIER_REVIEW_INVALID", 400);
  const text = clean(note, 600);
  if (state === "bad" && !text) throw AppError.of("SUPPLIER_REVIEW_NOTE", 400);
  const now = new Date();
  if (target === "form") {
    if (!s.formSubmittedAt) throw AppError.of("SUPPLIER_NOTHING_TO_REVIEW", 400);
    const wrong = state === "bad" ? [...new Set((Array.isArray(fields) ? fields : []).filter((k) => SUPPLIER_FIELD_KEYS.includes(k)))] : [];
    if (state === "bad" && !wrong.length) throw AppError.of("SUPPLIER_REVIEW_FIELDS", 400);
    s.formReview = { state, note: text, fields: wrong, at: now, by };
    return settle(s);
  }
  const row = rowOf(s, target);
  if (!row) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(target));
  if (!rowDone(row)) throw AppError.of("SUPPLIER_NOTHING_TO_REVIEW", 400);
  row.review = { state, note: text, fields: [], at: now, by };
  return settle(s);
}

/** The coordinator looked at the card's updates. */
async function markSeen(s) {
  const now = new Date();
  for (const u of s.updates || []) if (!u.seenAt) u.seenAt = now;
  await s.save();
  return s;
}

/**
 * The last steps, in the coordinator's hands: `pdf` (the summary was
 * generated), `subject` / `body` (copied into the mail), `sent` - allowed
 * only after the three, and only when everything is תקין.
 */
async function emailStep(s, { step, to, by }) {
  if (s.email?.sentAt) throw AppError.of("SUPPLIER_DONE", 400);
  if (computeStatus(s) !== "approved") throw AppError.of("SUPPLIER_NOT_APPROVED", 400);
  const now = new Date();
  if (step === "pdf") s.email.pdfAt = now;
  else if (step === "subject") s.email.subjectAt = now;
  else if (step === "body") {
    s.email.bodyAt = now;
    if (to && typeof to === "object") s.email.to = { name: clean(to.name, 60) || "", gender: SUPPLIER_GENDER_KEYS.includes(to.gender) ? to.gender : "" };
  } else if (step === "sent") {
    if (!s.email.pdfAt || !s.email.subjectAt || !s.email.bodyAt) throw AppError.of("SUPPLIER_EMAIL_STEPS", 400);
    s.email.sentAt = now;
    s.email.sentBy = by;
  } else throw AppError.of("INVALID_STATUS", 400, String(step));
  return settle(s);
}

/** The supplier and every stored file of theirs. */
async function remove(s) {
  const ids = (s.files || []).map((r) => r.file?.stored).filter(Boolean);
  if (ids.length) await StoredFile.deleteMany({ _id: { $in: ids } });
  await Supplier.deleteOne({ _id: s._id });
}

/* ───────────────────────── the supplier's side (behind the link) ───────────────────────── */

async function resolveToken({ world, token }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("SUPPLIER_LINK_INVALID", 404);
  const s = await Supplier.findOne({ world, "link.token": t });
  if (!s) throw AppError.of("SUPPLIER_LINK_INVALID", 404);
  if (!s.linkLive()) throw AppError.of("SUPPLIER_LINK_EXPIRED", 410);
  return s;
}

/**
 * The supplier opened the page - noted once as the first time, always as
 * the last. Best effort: the page must render even when the database
 * refuses writes (the Atlas quota, 2026-10-14), so a failed note is logged
 * and the view goes out as it was.
 */
async function noteOpened(s) {
  const now = new Date();
  const first = !s.link.openedAt;
  if (first) {
    s.link.openedAt = now;
    s.updates.push({ at: now, kind: "opened", text: "פתח/ה את הקישור" });
  }
  s.link.lastOpenedAt = now;
  try {
    await s.save();
  } catch (err) {
    console.error("supplier: the opening was not noted -", err.message);
    if (first) {
      s.link.openedAt = undefined;
      s.updates.pop();
    }
  }
  return s;
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * The form, validated the way the paper asks: the starred fields must be
 * there, numbers must be numbers. Allowed until the coordinator approved
 * the form; a form marked לא תקין goes back to pending when re-sent.
 */
async function submitForm(s, body = {}) {
  if (s.formReview?.state === "ok") throw AppError.of("SUPPLIER_FORM_LOCKED", 400);
  const f = {};
  const bad = [];
  f.companyName = clean(body.companyName, 120);
  f.businessId = digits(body.businessId) || undefined;
  if (!f.businessId || f.businessId.length < 5 || f.businessId.length > 9) bad.push("businessId");
  const a = body.address && typeof body.address === "object" ? body.address : {};
  f.address = { city: clean(a.city, 60), street: clean(a.street, 80), number: clean(a.number, 10), zip: digits(a.zip) || undefined };
  if (f.address.zip && ![5, 7].includes(f.address.zip.length)) bad.push("address");
  f.officePhone = clean(body.officePhone, 30);
  if (f.officePhone && digits(f.officePhone).length < 7) bad.push("officePhone");
  f.contactName = clean(body.contactName, 80);
  f.contactPhone = clean(body.contactPhone, 30);
  if (!f.contactPhone || digits(f.contactPhone).length < 9) bad.push("contactPhone");
  f.contactEmail = clean(body.contactEmail, 120)?.toLowerCase();
  if (!f.contactEmail || !EMAIL_RE.test(f.contactEmail)) bad.push("contactEmail");
  f.accountOwners = clean(body.accountOwners, 120);
  const bank = body.bank && typeof body.bank === "object" ? body.bank : {};
  f.bank = { code: Number.isInteger(Number(bank.code)) && bank.code !== "" && bank.code != null ? Number(bank.code) : undefined, name: clean(bank.name, 80) };
  if (f.bank.code == null || !f.bank.name) bad.push("bank");
  const branch = body.branch && typeof body.branch === "object" ? body.branch : {};
  f.branch = { code: digits(branch.code) ? Number(digits(branch.code)) : undefined, name: clean(branch.name, 80) };
  if (f.branch.code == null) bad.push("branch");
  f.accountNumber = digits(body.accountNumber) || undefined;
  if (!f.accountNumber || f.accountNumber.length < 3 || f.accountNumber.length > 13) bad.push("accountNumber");
  if (bad.length) throw AppError.of("SUPPLIER_FORM_INVALID", 400, bad.map((k) => FIELD_BY_KEY[k].label).join(", "));
  f.paymentTerms = SUPPLIER_PAYMENT_TERMS;

  const now = new Date();
  const first = !s.formSubmittedAt;
  const wasBad = s.formReview?.state === "bad";
  s.form = f;
  if (first) s.formSubmittedAt = now;
  s.formUpdatedAt = now;
  s.formReview = { state: "pending", fields: [] };
  s.updates.push({ at: now, kind: "form", text: first ? "מילא/ה את הטופס" : wasBad ? "תיקן/ה את הטופס" : "עדכן/ה את הטופס" });
  return settle(s);
}

/** One certificate: base64 in, StoredFile out. An approved file is locked. */
async function uploadFile(s, { key, fileName, mime, data, thumb }) {
  const def = FILE_BY_KEY[key];
  if (!def) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
  const row = rowOf(s, key);
  if (row.review?.state === "ok") throw AppError.of("SUPPLIER_FILE_LOCKED", 400);
  const kind = fileKind(mime, fileName);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!kind || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("DOCUMENT_INVALID", 400);
  const thumbBuf = parseThumb(thumb);
  if (row.file?.stored) await StoredFile.deleteOne({ _id: row.file.stored });
  const name = clean(fileName, 120) || `${key}.${kind.ext}`;
  const stored = await StoredFile.create({ world: s.world, name, mime: kind.mime, size: buffer.length, data: buffer, ...(thumbBuf && { thumb: thumbBuf }) });
  const now = new Date();
  const wasBad = row.review?.state === "bad";
  const again = !!row.file?.stored || row.notApplicable;
  row.file = { stored: stored._id, name, mime: kind.mime, size: buffer.length, thumb: !!thumbBuf, uploadedAt: now };
  row.notApplicable = false;
  row.review = { state: "pending", fields: [] };
  s.updates.push({ at: now, kind: "file", key, text: `${wasBad ? "העלה/תה מחדש" : again ? "החליף/ה" : "העלה/תה"} ${def.label}` });
  return settle(s);
}

/** A thumbnail as the client sends it: base64 JPEG/PNG/WebP (data-URI tolerated), ≤ 256KB. */
const MAX_THUMB_BYTES = 256 * 1024;
function parseThumb(thumb) {
  if (!thumb || typeof thumb !== "string") return null;
  const m = thumb.match(/^data:([^;]+);base64,/);
  if (m && !/^image\/(jpeg|jpg|png|webp)$/i.test(m[1])) return null;
  const buf = Buffer.from(thumb.replace(/^data:[^;]+;base64,/, ""), "base64");
  return buf.length > 0 && buf.length <= MAX_THUMB_BYTES ? buf : null;
}

/** Pull back a file the coordinator has not approved. */
async function removeFile(s, key) {
  const row = rowOf(s, key);
  if (!row) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
  if (row.review?.state === "ok") throw AppError.of("SUPPLIER_FILE_LOCKED", 400);
  if (row.file?.stored) await StoredFile.deleteOne({ _id: row.file.stored });
  row.file = undefined;
  row.notApplicable = false;
  row.review = { state: "pending", fields: [] };
  return settle(s);
}

/** "לא רלוונטי" on the optional certificate (עוסק פטור) - or back to open. */
async function setNotApplicable(s, key, value) {
  const def = FILE_BY_KEY[key];
  if (!def) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
  if (def.required) throw AppError.of("SUPPLIER_FILE_REQUIRED", 400);
  const row = rowOf(s, key);
  if (row.review?.state === "ok") throw AppError.of("SUPPLIER_FILE_LOCKED", 400);
  const on = value !== false;
  if (on && row.file?.stored) {
    await StoredFile.deleteOne({ _id: row.file.stored });
    row.file = undefined;
  }
  const wasBad = row.review?.state === "bad";
  row.notApplicable = on;
  row.review = { state: "pending", fields: [] };
  if (on) s.updates.push({ at: new Date(), kind: "file", key, text: `${wasBad ? "סימן/ה שוב" : "סימן/ה"} ש${def.label} לא רלוונטי` });
  return settle(s);
}

/** The bytes of a row's file → { mime, name, data } | null */
async function fileOf(row) {
  if (!row?.file?.stored) return null;
  const f = await StoredFile.findById(row.file.stored).select("name mime data");
  return f ? { mime: row.file.mime || f.mime, name: row.file.name || f.name, data: f.data } : null;
}
async function thumbOf(row) {
  if (!row?.file?.stored || !row.file.thumb) return null;
  const f = await StoredFile.findById(row.file.stored).select("thumb");
  return f?.thumb?.length ? { mime: "image/jpeg", data: f.thumb } : null;
}

/* ───────────────────────── views ───────────────────────── */

const reviewView = (r) => ({ state: r?.state || "pending", note: r?.note || null, fields: r?.fields || [], at: r?.at || null });

const fileRowView = (s, key) => {
  const def = FILE_BY_KEY[key];
  const row = rowOf(s, key) || {};
  return {
    key,
    label: def.label,
    required: !!def.required,
    hint: def.hint || null,
    fileName: row.file?.name || null,
    mime: row.file?.mime || null,
    size: row.file?.size || null,
    thumb: !!row.file?.thumb,
    uploadedAt: row.file?.uploadedAt || null,
    notApplicable: !!row.notApplicable,
    done: rowDone(row),
    review: reviewView(row.review),
  };
};

/** What the supplier sees behind the link - theirs and only theirs. */
function publicView(s) {
  const status = computeStatus(s);
  return {
    firstName: s.firstName,
    lastName: s.lastName,
    gender: s.gender,
    /** Who sent the link - the page says who checks the file. */
    coordinator: s.createdBy || null,
    status,
    statusLabel: SUPPLIER_STATUS_LABELS[status],
    link: { expiresAt: s.link?.expiresAt || null },
    form: s.formSubmittedAt ? s.form : null,
    formSubmittedAt: s.formSubmittedAt || null,
    formReview: reviewView(s.formReview),
    files: SUPPLIER_FILES.map((f) => fileRowView(s, f.key)),
    counts: fileCounts(s),
    paymentTerms: SUPPLIER_PAYMENT_TERMS,
    maxFileBytes: MAX_FILE_BYTES,
    done: !!s.email?.sentAt,
  };
}

/** What the coordinator's pages read - the record plus the derived facts. */
function staffView(s) {
  const obj = s.toObject ? s.toObject() : s;
  return {
    ...obj,
    status: computeStatus(s),
    statusLabel: SUPPLIER_STATUS_LABELS[computeStatus(s)],
    linkLive: s.linkLive ? s.linkLive() : false,
    fileRows: SUPPLIER_FILES.map((f) => fileRowView(s, f.key)),
    counts: fileCounts(s),
    unseen: unseenCount(s),
  };
}

module.exports = {
  MAX_FILE_BYTES,
  INLINE_MIMES,
  computeStatus,
  fileCounts,
  filesComplete,
  create,
  updateDetails,
  renewLink,
  review,
  markSeen,
  emailStep,
  remove,
  resolveToken,
  noteOpened,
  submitForm,
  uploadFile,
  removeFile,
  setNotApplicable,
  fileOf,
  thumbOf,
  rowOf,
  publicView,
  staffView,
};
