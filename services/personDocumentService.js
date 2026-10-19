/**
 * @file personDocumentService - a person's own papers (PersonDocument):
 * a teacher's syllabus and whatever else the staff files on them. The
 * bytes go to `files` (StoredFile) with the thumbnail the client made;
 * the row carries the facts the page lists.
 * @module services/personDocumentService
 */

const PersonDocument = require("../models/PersonDocument");
const StoredFile = require("../models/StoredFile");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { PERSON_DOCUMENT_KIND_KEYS } = require("../utils/domain");
// the same file rules as the intake documents and the supplier's certificates: PDF / images / Word, ≤ 8MB
const { fileKind, MAX_FILE_BYTES, INLINE_MIMES } = require("./intakeService");

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

/** Every document of the world (the client's slice), or of one person; newest first. */
async function list({ world, personId = null, persons = null }) {
  const filter = { world };
  if (personId) filter.person = personId;
  else if (persons) filter.person = { $in: [...persons] };
  const docs = await PersonDocument.find(filter).sort({ uploadedAt: -1 }).lean();
  return docs.map(view);
}

async function add({ world, personId, kind, label, fileName, mime, data, thumb, by, note }) {
  const person = await Person.findOne({ _id: personId, world, deletedAt: null }).select("_id").lean();
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  const k = PERSON_DOCUMENT_KIND_KEYS.includes(kind) ? kind : "other";
  const fk = fileKind(mime, fileName);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!fk || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw AppError.of("PERSON_DOCUMENT_INVALID", 400);
  const thumbBuf = parseThumb(thumb);
  const name = clean(fileName, 120) || `${k}.${fk.ext}`;
  const stored = await StoredFile.create({ world, name, mime: fk.mime, size: buffer.length, data: buffer, ...(thumbBuf && { thumb: thumbBuf }) });
  const doc = await PersonDocument.create({
    world,
    person: personId,
    kind: k,
    label: clean(label, 120),
    file: stored._id,
    name,
    mime: fk.mime,
    size: buffer.length,
    thumb: !!thumbBuf,
    uploadedBy: clean(by, 80),
    note: clean(note, 500),
  });
  return view(doc);
}

async function load({ world, personId, docId }) {
  const doc = await PersonDocument.findOne({ _id: docId, world, ...(personId && { person: personId }) });
  if (!doc) throw AppError.of("NOT_FOUND", 404, "מסמך");
  return doc;
}

async function remove({ world, personId, docId }) {
  const doc = await load({ world, personId, docId });
  await StoredFile.deleteOne({ _id: doc.file });
  await PersonDocument.deleteOne({ _id: doc._id });
}

/** The bytes → { mime, name, data } | null */
async function fileOf(doc) {
  const f = await StoredFile.findById(doc.file).select("name mime data");
  return f ? { mime: doc.mime || f.mime, name: doc.name || f.name, data: f.data } : null;
}

async function thumbOf(doc) {
  if (!doc.thumb) return null;
  const f = await StoredFile.findById(doc.file).select("thumb");
  return f?.thumb?.length ? { mime: "image/jpeg", data: f.thumb } : null;
}

module.exports = { list, add, load, remove, fileOf, thumbOf, INLINE_MIMES };
