/**
 * @file Invoice service - חשבוניות של מורים
 * @module services/invoiceService
 *
 * The rules, in one place:
 *  - an invoice is a picture (JPG / PNG / WebP / GIF / AVIF / BMP, ≤ 8MB)
 *    of a teacher who holds an active Teacher profile;
 *  - it names at least one lesson, and every lesson named is one that
 *    teacher taught: the lesson's own teacher (a substitute) when set,
 *    else the teacher of the lesson's cycle;
 *  - a lesson is billed once (the unique index on invoiceLessons.lesson);
 *  - the picture, the invoice and its lesson rows are written as one unit
 *    (a transaction on Atlas; sequential with cleanup where transactions
 *    are not available, e.g. the test database).
 *
 * Reads return a lean shape: { _id, teacher, file: {_id, name, mime, size},
 * uploadedAt, uploadedBy, note, lessons: [{ _id, cycle, date }] }.
 */

const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const InvoiceLesson = require("../models/InvoiceLesson");
const InvoiceRequest = require("../models/InvoiceRequest");
const InvoiceRound = require("../models/InvoiceRound");
const StoredFile = require("../models/StoredFile");
const Lesson = require("../models/Lesson");
const Cycle = require("../models/Cycle");
const { Person } = require("../models/Person");
const { Profile } = require("../models/Profile");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** What an invoice may be: a picture, or the PDF the teacher's invoicing software made (Eden, 2026-10-21: "למה רשום רק צילום ולא העלאה"). */
const FILE_MIMES = new Set(["image/jpeg", "image/pjpeg", "image/png", "image/x-png", "image/webp", "image/gif", "image/avif", "image/bmp", "application/pdf", "application/x-pdf"]);
const THUMB_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_THUMB_BYTES = 256 * 1024;

const isId = (v) => mongoose.isValidObjectId(v);
const uniq = (ids) => [...new Set((ids || []).map(String))];

const NORMAL_MIME = { "image/pjpeg": "image/jpeg", "image/x-png": "image/png", "application/x-pdf": "application/pdf" };

/** "data:<mime>;base64,…" of an image or a PDF → { mime, buffer } - or the typed error. */
function parseImage(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!m) throw AppError.of("INVOICE_IMAGE_INVALID", 400);
  const mime = m[1].toLowerCase();
  if (!FILE_MIMES.has(mime)) throw AppError.of("INVOICE_IMAGE_INVALID", 400);
  const buffer = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw AppError.of("INVOICE_IMAGE_INVALID", 400);
  return { mime: NORMAL_MIME[mime] || mime, buffer };
}

/** The small JPEG the uploader rendered of the file (a PDF's first page, a shrunk photo) - optional, ≤ 256KB, never a reason to refuse. */
function parseThumb(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!m || !THUMB_MIMES.has(m[1].toLowerCase())) return null;
  const buffer = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  return buffer.length && buffer.length <= MAX_THUMB_BYTES ? buffer : null;
}

/** The teacher of a lesson: the substitute written on it, else the cycle's. */
const teacherOfLesson = (lesson, cycleById) => String(lesson.teacher || cycleById.get(String(lesson.cycle))?.teacher || "");

/**
 * The lessons `teacherId` taught in `world` - those a new invoice may
 * name. Each carries `invoice` (the id, or null) so a picker can grey out
 * the billed ones. Newest first.
 */
async function lessonsOfTeacher({ world, teacherId, limit = 400, cycleIds = null }) {
  if (!isId(teacherId)) throw AppError.of("NOT_FOUND", 404, "מורה");
  // `cycleIds` (a Set, from the lens) keeps the lessons on the persona's side only
  const inLens = (ids) => (cycleIds ? ids.filter((id) => cycleIds.has(String(id))) : ids);
  const cycles = await Cycle.find({ world, teacher: teacherId }).select("_id").lean();
  const own = inLens(cycles.map((c) => c._id));
  const substituted = cycleIds ? { teacher: teacherId, cycle: { $in: [...cycleIds].map((id) => new mongoose.Types.ObjectId(id)) } } : { teacher: teacherId };
  const lessons = await Lesson.find({
    world,
    source: "live",
    $or: [substituted, { cycle: { $in: own }, teacher: null }],
  })
    .select("_id cycle date teacher")
    .sort({ date: -1 })
    .limit(limit)
    .lean();
  const billed = await InvoiceLesson.find({ lesson: { $in: lessons.map((l) => l._id) } }).select("lesson invoice").lean();
  const invoiceByLesson = new Map(billed.map((b) => [String(b.lesson), b.invoice]));
  return lessons.map((l) => ({ _id: l._id, cycle: l.cycle, date: l.date, invoice: invoiceByLesson.get(String(l._id)) || null }));
}

/** The lessons that may go on an invoice of this teacher: exist, in the world, taught by them - and, under a lens, on its side. */
async function assertLessonsOfTeacher({ world, teacherId, lessonIds, cycleIds = null }) {
  const ids = uniq(lessonIds).filter(isId);
  if (!ids.length) throw AppError.of("INVOICE_NO_LESSONS", 400);
  const lessons = await Lesson.find({ _id: { $in: ids }, world, source: "live" }).select("_id cycle teacher").lean();
  if (lessons.length !== ids.length) throw AppError.of("NOT_FOUND", 404, "שיעור");
  const cycleById = new Map((await Cycle.find({ _id: { $in: lessons.map((l) => l.cycle) } }).select("_id teacher").lean()).map((c) => [String(c._id), c]));
  if (lessons.some((l) => teacherOfLesson(l, cycleById) !== String(teacherId))) throw AppError.of("INVOICE_LESSON_NOT_TEACHERS", 400);
  if (cycleIds && lessons.some((l) => !cycleIds.has(String(l.cycle)))) throw AppError.of("OUT_OF_SCOPE", 403);
  return ids;
}

/**
 * Is this (shaped) invoice the lens's to see? `people` / `cycleIds` are the
 * lens's sets (null = everyone / every cycle): the teacher must be in the
 * lens and at least one billed lesson on its side - a hostels coordinator
 * never sees an invoice of college lessons alone, nor a manager one of
 * hostel lessons alone.
 */
function visibleTo(invoice, people, cycleIds) {
  if (people && !people.has(String(invoice.teacher))) return false;
  if (cycleIds && !(invoice.lessons || []).some((l) => cycleIds.has(String(l.cycle)))) return false;
  return true;
}

async function assertTeacher({ world, teacherId }) {
  if (!isId(teacherId)) throw AppError.of("NOT_FOUND", 404, "מורה");
  const person = await Person.findOne({ _id: teacherId, world, deletedAt: null }).select("_id").lean();
  const profile = person && (await Profile.findOne({ person: teacherId, kind: "Teacher", active: true }).select("_id").lean());
  if (!profile) throw AppError.of("INVOICE_NOT_A_TEACHER", 400);
}

/**
 * The lean shape of one or many invoices (see the header). An invoice that
 * came through a teacher's link also says `viaLink` and `locked` ("done"
 * once the teacher finished, "mailed" once the month's mail went): then
 * only the super admin changes or deletes it (decision 1 of the state
 * machine, 2026-10-22).
 */
async function shape(world, invoices) {
  const ids = invoices.map((i) => i._id);
  const requestIds = [...new Set(invoices.map((i) => i.request).filter(Boolean).map(String))];
  const [rows, files, requests] = await Promise.all([
    InvoiceLesson.find({ invoice: { $in: ids } }).select("invoice lesson").lean(),
    // whether a thumbnail exists, without pulling its bytes
    StoredFile.aggregate([{ $match: { _id: { $in: invoices.map((i) => i.file) } } }, { $project: { name: 1, mime: 1, size: 1, thumb: { $gt: [{ $binarySize: { $ifNull: ["$thumb", ""] } }, 0] } } }]),
    requestIds.length ? InvoiceRequest.find({ _id: { $in: requestIds } }).select("completedAt round").lean() : [],
  ]);
  const roundIds = [...new Set(requests.map((r) => String(r.round)))];
  const mailed = new Set((roundIds.length ? await InvoiceRound.find({ _id: { $in: roundIds }, "mail.sentAt": { $ne: null } }).select("_id").lean() : []).map((r) => String(r._id)));
  const lockOf = new Map(requests.map((r) => [String(r._id), r.completedAt ? "done" : mailed.has(String(r.round)) ? "mailed" : null]));
  const lessonDocs = await Lesson.find({ _id: { $in: rows.map((r) => r.lesson) } }).select("_id cycle date").lean();
  const lessonById = new Map(lessonDocs.map((l) => [String(l._id), l]));
  const fileById = new Map(files.map((f) => [String(f._id), f]));
  const lessonsByInvoice = new Map();
  for (const r of rows) {
    const k = String(r.invoice);
    if (!lessonsByInvoice.has(k)) lessonsByInvoice.set(k, []);
    const l = lessonById.get(String(r.lesson));
    if (l) lessonsByInvoice.get(k).push(l);
  }
  return invoices.map((i) => ({
    _id: i._id,
    world,
    teacher: i.teacher,
    file: fileById.get(String(i.file)) || null,
    uploadedAt: i.uploadedAt,
    uploadedBy: i.uploadedBy,
    note: i.note,
    request: i.request || null,
    viaLink: !!i.request,
    locked: i.request ? lockOf.get(String(i.request)) || null : null,
    lessons: (lessonsByInvoice.get(String(i._id)) || []).sort((a, b) => new Date(a.date) - new Date(b.date)),
    createdAt: i.createdAt,
  }));
}

async function listInvoices({ world, teacherId, people = null, cycleIds = null }) {
  const filter = { world };
  if (teacherId) filter.teacher = isId(teacherId) ? teacherId : null;
  if (people) filter.teacher = teacherId ? (people.has(String(teacherId)) ? filter.teacher : null) : { $in: [...people].map((id) => new mongoose.Types.ObjectId(id)) };
  const invoices = await Invoice.find(filter).sort({ uploadedAt: -1 }).lean();
  const shaped = await shape(world, invoices);
  return cycleIds ? shaped.filter((i) => visibleTo(i, null, cycleIds)) : shaped;
}

async function loadInvoice(world, invoiceId) {
  const invoice = isId(invoiceId) && (await Invoice.findOne({ _id: invoiceId, world }));
  if (!invoice) throw AppError.of("NOT_FOUND", 404, "חשבונית");
  return invoice;
}

async function getInvoice({ world, invoiceId }) {
  const invoice = await loadInvoice(world, invoiceId);
  return (await shape(world, [invoice.toObject()]))[0];
}

/**
 * The bytes of the file (and their type); with `thumb` the small JPEG the
 * uploader rendered - an image without one answers with itself, a PDF
 * without one is not found (the page shows the PDF glyph).
 */
async function imageOf({ world, invoiceId, thumb = false }) {
  const invoice = await loadInvoice(world, invoiceId);
  const file = await StoredFile.findOne({ _id: invoice.file, world });
  if (!file) throw AppError.of("NOT_FOUND", 404, "קובץ החשבונית");
  if (!thumb) return file;
  if (file.thumb?.length) return { _id: file._id, updatedAt: file.updatedAt, mime: "image/jpeg", data: file.thumb };
  if (file.mime.startsWith("image/")) return file;
  throw AppError.of("NOT_FOUND", 404, "תמונה מוקטנת");
}

/** The duplicate-key error of the unique lesson index → the typed 409. */
const billedTwice = (e) => (e && e.code === 11000 ? AppError.of("INVOICE_LESSON_BILLED", 409) : e);

/**
 * A new invoice: { teacherId, lessonIds, imageData (data URL of an image or
 * a PDF), imageName, thumb (data URL of a small JPEG, optional), by, note }.
 */
async function createInvoice({ world, teacherId, lessonIds, imageData, imageName, thumb, by, note, cycleIds = null, requestId = null }) {
  await assertTeacher({ world, teacherId });
  const ids = await assertLessonsOfTeacher({ world, teacherId, lessonIds, cycleIds });
  const image = parseImage(imageData);
  const thumbBuf = parseThumb(thumb);
  const invoiceId = await withTxn(async (session) => {
    const opts = session ? { session } : {};
    let fileId = null;
    let newId = null;
    try {
      const [file] = await StoredFile.create([{ world, name: imageName || undefined, mime: image.mime, size: image.buffer.length, data: image.buffer, ...(thumbBuf && { thumb: thumbBuf }) }], opts);
      fileId = file._id;
      const [invoice] = await Invoice.create([{ world, teacher: teacherId, file: file._id, uploadedBy: by, note: note || undefined, request: requestId || null }], opts);
      newId = invoice._id;
      await InvoiceLesson.insertMany(ids.map((lesson) => ({ world, invoice: invoice._id, lesson })), { ...opts, ordered: true });
      return invoice._id;
    } catch (e) {
      // no transaction (tests): take back what was written before the refusal
      if (!session) {
        if (newId) await InvoiceLesson.deleteMany({ invoice: newId });
        if (newId) await Invoice.deleteOne({ _id: newId });
        if (fileId) await StoredFile.deleteOne({ _id: fileId });
      }
      throw billedTwice(e);
    }
  });
  return getInvoice({ world, invoiceId });
}

/** Replace the lessons of an invoice (still at least one) and/or its note. */
async function updateInvoice({ world, invoiceId, lessonIds, note, cycleIds = null }) {
  const invoice = await loadInvoice(world, invoiceId);
  if (lessonIds !== undefined) {
    const ids = await assertLessonsOfTeacher({ world, teacherId: invoice.teacher, lessonIds, cycleIds });
    await withTxn(async (session) => {
      const opts = session ? { session } : {};
      const current = (await InvoiceLesson.find({ invoice: invoice._id }).select("lesson").session(session || null)).map((r) => String(r.lesson));
      const gone = current.filter((id) => !ids.includes(id));
      const added = ids.filter((id) => !current.includes(id));
      if (gone.length) await InvoiceLesson.deleteMany({ invoice: invoice._id, lesson: { $in: gone } }, opts);
      try {
        if (added.length) await InvoiceLesson.insertMany(added.map((lesson) => ({ world, invoice: invoice._id, lesson })), { ...opts, ordered: true });
      } catch (e) {
        if (!session && gone.length) await InvoiceLesson.insertMany(gone.map((lesson) => ({ world, invoice: invoice._id, lesson })));
        throw billedTwice(e);
      }
    });
  }
  if (note !== undefined) {
    invoice.note = note ? String(note).trim() : undefined;
    await invoice.save();
  }
  return getInvoice({ world, invoiceId });
}

/** Remove an invoice: its lesson rows and its picture go with it. */
async function deleteInvoice({ world, invoiceId }) {
  const invoice = await loadInvoice(world, invoiceId);
  await withTxn(async (session) => {
    const opts = session ? { session } : {};
    await InvoiceLesson.deleteMany({ invoice: invoice._id }, opts);
    await Invoice.deleteOne({ _id: invoice._id }, opts);
    await StoredFile.deleteOne({ _id: invoice.file }, opts);
  });
}

module.exports = {
  MAX_IMAGE_BYTES,
  parseImage,
  lessonsOfTeacher,
  listInvoices,
  getInvoice,
  visibleTo,
  imageOf,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  shape,
};
