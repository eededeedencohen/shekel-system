/**
 * @file Library service - the ONLY write path for הספרייה (books + loans)
 * @module services/libraryService
 *
 * Eden's rules (2026-09-09):
 *  - ONE copy per book: a book is on the shelf or with exactly ONE student.
 *    `lend()` refuses a second open loan; the partial unique index on
 *    loans (book, open:true) is the backstop under concurrency.
 *  - A return date is a DAY (local midnight), tomorrow at the earliest,
 *    never a Friday or Shabbat (the library is closed), at most
 *    LIBRARY.maxLoanDays ahead.
 *  - הארכה (extend) only moves the date LATER than the current one (and
 *    later than today when the loan is already overdue).
 *  - Books are soft-deleted, never while on loan; re-adding a deleted
 *    barcode restores the record (its loan history comes back with it).
 *
 * A cover is a `files` row in the bucket (`cover.file`, see models/Book,
 * since 2026-10-26): the page uploads one straight to the bucket, a cover
 * the lookup downloaded or the page sent as a data URL goes up from here
 * (storedFiles.createFromBuffer).
 */

const Book = require("../models/Book");
const Loan = require("../models/Loan");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const { LIBRARY, BOOK_SOURCES } = require("../utils/domain");
const lookup = require("./bookLookupService");
const StoredFile = require("../models/StoredFile");
const storedFiles = require("./storedFiles");

const DAY = 86400000;
// every image type a browser draws in <img> (HEIC is not one - the page converts it first)
const COVER_MIME_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/x-png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp" };
const MAX_COVER_BYTES = lookup.MAX_COVER_BYTES;

/* ───────────────────────── files ───────────────────────── */
/** The cover's row and its object go. */
async function removeCover(book) {
  if (book?.cover?.file) await storedFiles.destroy(book.cover.file);
  book.cover = undefined;
}
/** The cover a book may carry (the bucket flow's check): the image types a browser draws, ≤ 3MB. */
function acceptCover(mime) {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  return COVER_MIME_EXT[m] ? { mime: m, ext: COVER_MIME_EXT[m] } : null;
}
/** Validate + store a cover the server holds (a data URL from the page, a download the lookup made): to the bucket, never inline. */
async function saveCover(book, cover) {
  const mime = String(cover?.mime || "").toLowerCase();
  if (!COVER_MIME_EXT[mime] || !cover.buffer?.length || cover.buffer.length > MAX_COVER_BYTES) throw AppError.of("COVER_INVALID", 400);
  await removeCover(book);
  const file = await storedFiles.createFromBuffer({ name: `${book.title || "cover"}.${COVER_MIME_EXT[mime]}`, mime, buffer: cover.buffer, family: "library", owner: { kind: "book", id: book._id } });
  book.cover = { file: file._id, mime, size: cover.buffer.length, savedAt: new Date() };
}
/** A cover uploaded straight to the bucket (fileService, family "library") and confirmed becomes the book's. */
async function saveCoverFile(book, fileId) {
  const file = await StoredFile.findOne({ _id: fileId, family: "library", status: "ready" });
  if (!file) throw AppError.of("NOT_FOUND", 404, "כריכה");
  if (book.cover?.file && String(book.cover.file) === String(file._id)) return;
  await removeCover(book);
  book.cover = { file: file._id, mime: file.mime, size: file.size, savedAt: new Date() };
  file.owner = { kind: "book", id: book._id };
  await storedFiles.markAttached(file);
}

/** "data:image/png;base64,…" → { mime, buffer } (COVER_INVALID otherwise). */
function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!m) throw AppError.of("COVER_INVALID", 400);
  const buffer = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  return { mime: m[1].toLowerCase(), buffer };
}

/* ───────────────────────── dates ───────────────────────── */

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * A return DAY out of "YYYY-MM-DD" (preferred) or any date string - local
 * midnight. null when unparsable.
 */
function parseDueDate(input) {
  if (input == null || input === "") return null;
  const s = String(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  let d;
  if (m && s.length === 10) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else {
    d = new Date(s);
    if (!isNaN(d.getTime())) d.setHours(0, 0, 0, 0);
  }
  return isNaN(d.getTime()) ? null : d;
}

/** The rules a return date must pass (`after` = the date it must exceed). */
function assertDueDate(due, { after } = {}) {
  if (!due) throw AppError.of("DUE_DATE_INVALID", 400);
  const today = startOfToday();
  if (due <= today) throw AppError.of("DUE_DATE_INVALID", 400);
  if (LIBRARY.closedDays.includes(due.getDay())) throw AppError.of("DUE_DATE_CLOSED", 400);
  if (due.getTime() - today.getTime() > LIBRARY.maxLoanDays * DAY) throw AppError.of("DUE_DATE_TOO_FAR", 400);
  if (after && due <= after) throw AppError.of("DUE_DATE_NOT_LATER", 400);
  return due;
}

/** Is an open loan past its day? */
const isOverdue = (loan) => !!loan && loan.open && new Date(loan.dueAt) < startOfToday();

/* ───────────────────────── books ───────────────────────── */

const EDITABLE = ["title", "author", "summary", "publisher", "year", "pages", "notes", "imageUrl", "productUrl"];

function assignFields(book, data) {
  for (const k of EDITABLE) {
    if (data[k] === undefined) continue;
    if (k === "year" || k === "pages") book[k] = data[k] === null || data[k] === "" ? undefined : Number(data[k]);
    else book[k] = data[k] == null ? "" : String(data[k]).trim();
  }
  if (data.source && BOOK_SOURCES.includes(data.source)) book.source = data.source;
}

/** The open loan of a book (populated student), or null. */
const openLoanOf = (bookId, session) =>
  Loan.findOne({ book: bookId, open: true }).session(session || null);

async function loadBook(bookId) {
  const book = await Book.findOne({ _id: bookId, deletedAt: null });
  if (!book) throw AppError.of("NOT_FOUND", 404, "ספר");
  return book;
}

/**
 * Add a book. `cover` is { mime, buffer } (a data URL the page sent, or
 * what the lookup downloaded); without one, `imageUrl` is fetched best-effort.
 */
async function createBook({ data, by, cover, coverFile = null }) {
  const barcode = lookup.normalizeBarcode(data.barcode);
  if (!barcode) throw AppError.of("BARCODE_INVALID", 400);
  if (!data.title || !String(data.title).trim()) throw AppError.of("MISSING_FIELDS", 400, "title");

  // The same book under any spelling of its code (leading zeros, ISBN
  // twins) is the same record - refuse a live one, restore a deleted one.
  let book = await Book.findOne({ barcode: { $in: lookup.barcodeVariants(barcode) } });
  if (book && !book.deletedAt) throw AppError.of("BOOK_EXISTS", 409);
  if (book) {
    book.deletedAt = null; // a deleted book comes back with its history
  } else {
    book = new Book({ barcode });
  }
  assignFields(book, data);
  book.addedBy = by || book.addedBy;
  if (!data.source) book.source = "manual";

  await book.save();
  if (coverFile) await saveCoverFile(book, coverFile);
  else if (cover) await saveCover(book, cover);
  else if (data.imageUrl && data.fetchCover !== false) {
    try {
      const dl = await lookup.downloadCover(data.imageUrl);
      if (dl && COVER_MIME_EXT[dl.mime]) await saveCover(book, dl);
    } catch {
      /* the cover is a nicety - the book is added without it */
    }
  }
  await book.save();
  return book;
}

async function updateBook({ bookId, data, by, cover, coverFile = null, removeCoverFlag }) {
  const book = await loadBook(bookId);
  if (data.barcode !== undefined) {
    const barcode = lookup.normalizeBarcode(data.barcode);
    if (!barcode) throw AppError.of("BARCODE_INVALID", 400);
    if (barcode !== book.barcode) {
      const clash = await Book.findOne({ barcode: { $in: lookup.barcodeVariants(barcode) }, _id: { $ne: book._id } });
      if (clash) throw AppError.of("BOOK_EXISTS", 409);
      book.barcode = barcode;
    }
  }
  assignFields(book, data);
  if (data.title !== undefined && !book.title) throw AppError.of("MISSING_FIELDS", 400, "title");
  if (removeCoverFlag) await removeCover(book);
  if (coverFile) await saveCoverFile(book, coverFile);
  else if (cover) await saveCover(book, cover);
  await book.save();
  return book;
}

/** Soft delete - never while the book is out. */
async function deleteBook({ bookId }) {
  const book = await loadBook(bookId);
  if (await openLoanOf(book._id)) throw AppError.of("BOOK_ON_LOAN", 409);
  book.deletedAt = new Date();
  await book.save();
  return book;
}

/* ───────────────────────── loans ───────────────────────── */

async function lend({ bookId, studentId, dueAt, by, note }) {
  const book = await loadBook(bookId);
  if (!studentId) throw AppError.of("MISSING_FIELDS", 400, "student");
  const student = await Person.findOne({ _id: studentId, deletedAt: null });
  if (!student) throw AppError.of("NOT_FOUND", 404, "סטודנט/ית");
  const due = assertDueDate(parseDueDate(dueAt));

  const loan = await withTxn(async (session) => {
    if (await openLoanOf(book._id, session)) throw AppError.of("BOOK_ON_LOAN", 409);
    const doc = new Loan({
      book: book._id,
      student: student._id,
      open: true,
      loanedAt: new Date(),
      dueAt: due,
      by,
      note: note ? String(note).trim() : undefined,
      log: [{ action: "lent", by, note: note ? String(note).trim() : undefined }],
    });
    try {
      await doc.save({ session: session || undefined });
    } catch (e) {
      if (e.code === 11000) throw AppError.of("BOOK_ON_LOAN", 409);
      throw e;
    }
    return doc;
  });
  return loan;
}

async function loadLoan(loanId) {
  const loan = await Loan.findById(loanId);
  if (!loan) throw AppError.of("NOT_FOUND", 404, "השאלה");
  return loan;
}

/** הארכת זמן - a later return day; the old one is kept in `extensions`. */
async function extend({ loanId, dueAt, by, note }) {
  const loan = await loadLoan(loanId);
  if (!loan.open) throw AppError.of("LOAN_CLOSED", 409);
  const floor = new Date(Math.max(new Date(loan.dueAt).getTime(), startOfToday().getTime()));
  const due = assertDueDate(parseDueDate(dueAt), { after: floor });
  loan.extensions.push({ from: loan.dueAt, to: due, by, note: note ? String(note).trim() : undefined });
  loan.dueAt = due;
  loan.log.push({ action: "extended", by, note: note ? String(note).trim() : undefined });
  await loan.save();
  return loan;
}

/** החזרת ספר - closes the loan; the book is back on the shelf. */
async function returnBook({ loanId, by, note }) {
  const loan = await loadLoan(loanId);
  if (!loan.open) throw AppError.of("LOAN_CLOSED", 409);
  loan.open = false;
  loan.returnedAt = new Date();
  loan.returnedBy = by;
  loan.log.push({ action: "returned", by, note: note ? String(note).trim() : undefined });
  await loan.save();
  return loan;
}

module.exports = {
  parseDataUrl,
  saveCover,
  saveCoverFile,
  acceptCover,
  MAX_COVER_BYTES,
  removeCover,
  parseDueDate,
  assertDueDate,
  startOfToday,
  isOverdue,
  openLoanOf,
  loadBook,
  createBook,
  updateBook,
  deleteBook,
  lend,
  extend,
  returnBook,
};
