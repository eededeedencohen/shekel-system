/**
 * @file personDocumentService - a person's own papers (PersonDocument):
 * a teacher's syllabus and whatever else the staff files on them. The
 * bytes go to `files` (StoredFile): since 2026-10-26 straight to the
 * bucket (fileService → `attach`), before that as base64 (`add`). The
 * row carries the facts the page lists.
 * @module services/personDocumentService
 */

const PersonDocument = require("../models/PersonDocument");
const StoredFile = require("../models/StoredFile");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { PERSON_DOCUMENT_KIND_KEYS } = require("../utils/domain");
// the same file rules as the intake documents and the supplier's certificates: PDF / images / Word, ≤ 8MB
const { fileKind, MAX_FILE_BYTES, INLINE_MIMES } = require("./intakeService");
const storedFiles = require("./storedFiles");

const MAX_THUMB_BYTES = 256 * 1024;
const clean = (s, max = 200) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);

/** A thumbnail as the client sends it: base64 JPEG/PNG/WebP (data-URI tolerated), ≤ 256KB. */
function parseThumb(thumb) {
  if (!thumb || typeof thumb !== "string") return null;
  const m = thumb.match(/^data:([^;]+);base64,/);
  if (m && !/^image\/(jpeg|jpg|png|webp)$/i.test(m[1])) return null;
  const buf = Buffer.from(thumb.replace(/^data:[^;]+;base64,/, ""), "base64");
  return buf.length > 0 && buf.length <= MAX_THUMB_BYTES ? buf : null;
}

const view = (d) => {
  const o = d.toObject ? d.toObject() : d;
  return { ...o, file: String(o.file) };
};

/** Every document (the client's slice), or of one person; newest first. */
async function list({ personId = null, persons = null }) {
  const filter = {};
  if (personId) filter.person = personId;
  else if (persons) filter.person = { $in: [...persons] };
  const docs = await PersonDocument.find(filter).sort({ uploadedAt: -1 }).lean();
  return docs.map(view);
}

/** The person a document may be filed on, or 404. */
async function assertPerson(personId) {
  const person = await Person.findOne({ _id: personId, deletedAt: null }).select("_id").lean();
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  return person;
}

/** Legacy path: base64 in → a `files` row in the database → the document row. */
async function add({ personId, kind, label, fileName, mime, data, thumb, by, note }) {
  await assertPerson(personId);
  const k = PERSON_DOCUMENT_KIND_KEYS.includes(kind) ? kind : "other";
  const fk = fileKind(mime, fileName);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!fk || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("PERSON_DOCUMENT_INVALID", 400);
  const thumbBuf = parseThumb(thumb);
  const name = clean(fileName, 120) || `${k}.${fk.ext}`;
  const stored = await StoredFile.create({ name, mime: fk.mime, size: buffer.length, data: buffer, ...(thumbBuf && { thumb: thumbBuf }), family: "people", owner: { kind: "person", id: personId }, uploadedBy: { label: clean(by, 80) } });
  return attach({ personId, stored, kind: k, label, note, by });
}

/** A `files` row (in the bucket, confirmed) becomes a document of the person. */
async function attach({ personId, stored, kind, label, note, by }) {
  await assertPerson(personId);
  const k = PERSON_DOCUMENT_KIND_KEYS.includes(kind) ? kind : "other";
  const doc = await PersonDocument.create({
    person: personId,
    kind: k,
    label: clean(label, 120),
    file: stored._id,
    name: stored.name,
    mime: stored.mime,
    size: stored.size,
    thumb: storedFiles.hasThumb(stored),
    uploadedBy: clean(by, 80),
    note: clean(note, 500),
  });
  return view(doc);
}

async function load({ personId, docId }) {
  const doc = await PersonDocument.findOne({ _id: docId, ...(personId && { person: personId }) });
  if (!doc) throw AppError.of("NOT_FOUND", 404, "מסמך");
  return doc;
}

async function remove({ personId, docId }) {
  const doc = await load({ personId, docId });
  await storedFiles.destroy(doc.file);
  await PersonDocument.deleteOne({ _id: doc._id });
}

/** The bytes → { mime, name, data } | null (legacy rows; a bucket file is answered by a redirect in the controller). */
async function fileOf(doc) {
  const f = await StoredFile.findById(doc.file).select("name mime data");
  return f && f.data?.length ? { mime: doc.mime || f.mime, name: doc.name || f.name, data: f.data } : null;
}

async function thumbOf(doc) {
  if (!doc.thumb) return null;
  const f = await StoredFile.findById(doc.file).select("thumb");
  return f?.thumb?.length ? { mime: "image/jpeg", data: f.thumb } : null;
}

module.exports = { list, add, attach, assertPerson, load, remove, fileOf, thumbOf, INLINE_MIMES };
