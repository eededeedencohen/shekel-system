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
const mongoose = require("mongoose");
const Supplier = require("../models/Supplier");
const StoredFile = require("../models/StoredFile");
const storedFiles = require("./storedFiles");
const { Person } = require("../models/Person");
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
async function create({ body = {}, by }) {
  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const gender = SUPPLIER_GENDER_KEYS.includes(body.gender) ? body.gender : null;
  const phone = clean(body.phone, 30);
  if (!firstName || !lastName || !gender || digits(phone).length < 9) throw AppError.of("SUPPLIER_INVALID", 400);
  const days = parseDays(body.days ?? 7);
  const s = new Supplier({
    firstName,
    lastName,
    gender,
    phone,
    createdBy: by,
    person: await personOf(body.person),
    link: { token: makeToken(), expiresAt: new Date(Date.now() + days * DAY_MS), days, createdAt: new Date(), by },
  });
  return settle(s);
}

/** The שק״ל person a file belongs to (a teacher, usually) - must exist; null / "" unlinks. */
async function personOf(id) {
  if (id == null || id === "") return null;
  const person = mongoose.isValidObjectId(id) && (await Person.findOne({ _id: id, deletedAt: null }).select("_id").lean());
  if (!person) throw AppError.of("SUPPLIER_PERSON_INVALID", 400);
  return person._id;
}

/** The name / gender / phone - what the coordinator typed first; and whose file it is. */
async function updateDetails(s, body = {}) {
  if ("firstName" in body) s.firstName = clean(body.firstName, 60) || s.firstName;
  if ("lastName" in body) s.lastName = clean(body.lastName, 60) || s.lastName;
  if ("gender" in body && SUPPLIER_GENDER_KEYS.includes(body.gender)) s.gender = body.gender;
  if ("phone" in body && digits(body.phone).length >= 9) s.phone = clean(body.phone, 30);
  if ("person" in body) s.person = await personOf(body.person);
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

/**
 * The super admin's corrections (Eden, 2026-10-15: "לסופר מנהל תן אפשרויות
 * למחוק דברים… או אפילו לערוך סטטוסים"). Every action rewrites one fact
 * and the status follows from the facts as always:
 *   reviewSet    { target, state, note? }   pending / ok / bad on the form or a file
 *   fileRemove   { key }                    the stored file goes (the row opens again)
 *   waive        { key, value }             "לא רלוונטי" on / off (the optional file)
 *   formReset                               the form is as if never sent
 *   emailSet     { step, on }               pdf / subject / body / sent - set now or unset
 *                                           (sent on = the file closes even without the
 *                                           three steps; sent off = it reopens)
 *   updatesClear                            the supplier's feed is emptied
 *   linkClose                               the link locks now
 *   coordinatorReset                        every verdict back to pending and the mail
 *                                           steps off - as if the coordinator never pressed
 */
async function adminAction(s, { action, target, key, state, note, value, step, on, by }) {
  const now = new Date();
  switch (action) {
    case "reviewSet": {
      if (!["pending", "ok", "bad"].includes(state)) throw AppError.of("SUPPLIER_REVIEW_INVALID", 400);
      const text = clean(note, 600);
      const review = state === "pending" ? { state: "pending", fields: [] } : { state, note: text, fields: [], at: now, by };
      if (target === "form") s.formReview = { ...review, fields: state === "bad" ? (Array.isArray(value) ? value.filter((k) => SUPPLIER_FIELD_KEYS.includes(k)) : []) : [] };
      else {
        const row = rowOf(s, target);
        if (!row) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(target));
        row.review = review;
      }
      return settle(s);
    }
    case "fileRemove": {
      const row = rowOf(s, key);
      if (!row) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
      if (row.file?.stored) await storedFiles.destroy(row.file.stored);
      row.file = {};
      row.notApplicable = false;
      row.review = { state: "pending", fields: [] };
      return settle(s);
    }
    case "waive": {
      const def = FILE_BY_KEY[key];
      if (!def) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
      const row = rowOf(s, key);
      const onIt = value !== false;
      if (onIt && row.file?.stored) {
        await storedFiles.destroy(row.file.stored);
        row.file = {};
      }
      row.notApplicable = onIt;
      row.review = { state: "pending", fields: [] };
      return settle(s);
    }
    case "formReset":
      s.form = { paymentTerms: SUPPLIER_PAYMENT_TERMS };
      s.formSubmittedAt = null;
      s.formUpdatedAt = null;
      s.formReview = { state: "pending", fields: [] };
      return settle(s);
    case "emailSet": {
      const field = { pdf: "pdfAt", subject: "subjectAt", body: "bodyAt", sent: "sentAt" }[step];
      if (!field) throw AppError.of("INVALID_STATUS", 400, String(step));
      if (on) {
        s.email[field] = now;
        if (step === "sent") s.email.sentBy = by;
      } else {
        s.email[field] = null;
        if (step === "sent") s.email.sentBy = null;
      }
      return settle(s);
    }
    case "updatesClear":
      s.updates = [];
      return settle(s);
    // everything the coordinator pressed, undone in one go (Eden, 2026-10-18): every תקין /
    // לא תקין back to pending, the four mail steps off - what the supplier sent stays
    case "coordinatorReset":
      s.formReview = { state: "pending", fields: [] };
      for (const row of s.files || []) row.review = { state: "pending", fields: [] };
      s.email = { pdfAt: null, subjectAt: null, bodyAt: null, sentAt: null, sentBy: null, to: { name: "", gender: "" } };
      return settle(s);
    case "linkClose":
      if (s.link) s.link.expiresAt = now;
      return settle(s);
    default:
      throw AppError.of("SUPPLIER_ADMIN_ACTION", 400, String(action));
  }
}

/** The supplier and every stored file of theirs. */
async function remove(s) {
  const ids = (s.files || []).map((r) => r.file?.stored).filter(Boolean);
  await storedFiles.destroyMany(ids);
  await Supplier.deleteOne({ _id: s._id });
}

/* ───────────────────────── the supplier's side (behind the link) ───────────────────────── */

async function resolveToken({ token }) {
  const t = String(token || "");
  if (!/^[\w-]{12,64}$/.test(t)) throw AppError.of("SUPPLIER_LINK_INVALID", 404);
  const s = await Supplier.findOne({ "link.token": t });
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
  s.finishedAt = null;
  s.formReview = { state: "pending", fields: [] };
  s.updates.push({ at: now, kind: "form", text: first ? "מילא/ה את הטופס" : wasBad ? "תיקן/ה את הטופס" : "עדכן/ה את הטופס" });
  return settle(s);
}

/** The certificate slot a file may go on (its definition), or the typed refusal; an approved file is locked. */
function assertFileSlot(s, key) {
  const def = FILE_BY_KEY[key];
  if (!def) throw AppError.of("SUPPLIER_FILE_UNKNOWN", 400, String(key));
  const row = rowOf(s, key);
  if (row.review?.state === "ok") throw AppError.of("SUPPLIER_FILE_LOCKED", 400);
  return { def, row };
}

/** One certificate: base64 in, StoredFile out. An approved file is locked. */
async function uploadFile(s, { key, fileName, mime, data, thumb }) {
  assertFileSlot(s, key);
  const kind = fileKind(mime, fileName);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!kind || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("DOCUMENT_INVALID", 400);
  const thumbBuf = parseThumb(thumb);
  const name = clean(fileName, 120) || `${key}.${kind.ext}`;
  // the bytes go to the bucket from here (never to the database) - the legacy base64 road, kept for old tabs and the tests
  const stored = await storedFiles.createFromBuffer({ name, mime: kind.mime, buffer, thumb: thumbBuf, family: "suppliers", owner: { kind: "supplier", id: s._id, slot: key }, uploadedBy: { token: "supplier" } });
  return attachFile(s, { key, stored });
}

/** A `files` row (uploaded straight to the bucket and confirmed, or just made from base64) becomes the certificate `key` (uploadFile's second half since 2026-10-26). */
async function attachFile(s, { key, stored }) {
  const { def, row } = assertFileSlot(s, key);
  if (row.file?.stored && String(row.file.stored) !== String(stored._id)) await storedFiles.destroy(row.file.stored);
  const now = new Date();
  const wasBad = row.review?.state === "bad";
  const again = !!row.file?.stored || row.notApplicable;
  row.file = { stored: stored._id, name: stored.name, mime: stored.mime, size: stored.size, thumb: storedFiles.hasThumb(stored), uploadedAt: now };
  row.notApplicable = false;
  row.review = { state: "pending", fields: [] };
  s.finishedAt = null;
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
  if (row.file?.stored) await storedFiles.destroy(row.file.stored);
  row.file = {};
  row.notApplicable = false;
  row.review = { state: "pending", fields: [] };
  s.finishedAt = null;
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
    await storedFiles.destroy(row.file.stored);
    row.file = {};
  }
  const wasBad = row.review?.state === "bad";
  row.notApplicable = on;
  row.review = { state: "pending", fields: [] };
  s.finishedAt = null;
  if (on) s.updates.push({ at: new Date(), kind: "file", key, text: `${wasBad ? "סימן/ה שוב" : "סימן/ה"} ש${def.label} לא רלוונטי` });
  return settle(s);
}

/**
 * The supplier's "שליחה" once the form is sent and every certificate is in
 * (Eden, 2026-10-23: even though the coordinator sees each thing as it
 * lands, the supplier wants the moment it all went). Any later change of
 * theirs clears it, so a fix is sent again - a fresh line for the coordinator.
 */
async function finish(s) {
  if (s.email?.sentAt) throw AppError.of("SUPPLIER_DONE", 400);
  if (!s.formSubmittedAt || !filesComplete(s)) throw AppError.of("SUPPLIER_NOT_COMPLETE", 400);
  const again = (s.updates || []).some((u) => u.kind === "finish");
  const now = new Date();
  s.finishedAt = now;
  s.updates.push({ at: now, kind: "finish", text: again ? "שלח/ה הכול מחדש - הטופס וכל האישורים בפנים" : "סיים/ה - הטופס וכל האישורים נשלחו" });
  return settle(s);
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
    /** The `files` row - what a signed read is asked for (GET /api/files/:id/url, or the link's /uploads/:id/url). */
    fileId: row.file?.stored ? String(row.file.stored) : null,
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
    /** The form sent and every certificate in - the "שליחה" may go. */
    complete: !!s.formSubmittedAt && filesComplete(s),
    finishedAt: s.finishedAt || null,
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
  FILE_BY_KEY,
  assertFileSlot,
  attachFile,
  computeStatus,
  fileCounts,
  filesComplete,
  create,
  updateDetails,
  renewLink,
  review,
  markSeen,
  emailStep,
  adminAction,
  remove,
  resolveToken,
  noteOpened,
  submitForm,
  uploadFile,
  removeFile,
  setNotApplicable,
  finish,
  rowOf,
  publicView,
  staffView,
};
