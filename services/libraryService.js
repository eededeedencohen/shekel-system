/**
 * @file Library service — the ONLY write path for הספרייה (books + loans)
 * @module services/libraryService
 *
 * Eden's rules (2026-09-09):
 *  - ONE copy per book: a book is on the shelf or with exactly ONE student.
 *    `lend()` refuses a second open loan; the partial unique index on
 *    loans (world, book, open:true) is the backstop under concurrency.
 *  - A return date is a DAY (local midnight), tomorrow at the earliest,
 *    never a Friday or Shabbat (the library is closed), at most
 *    LIBRARY.maxLoanDays ahead.
 *  - הארכה (extend) only moves the date LATER than the current one (and
 *    later than today when the loan is already overdue).
 *  - Books are soft-deleted, never while on loan; re-adding a deleted
 *    barcode restores the record (its loan history comes back with it).
 *
 * Covers live under UPLOAD_DIR/<world>/books/<bookId>.<ext> — same root as
 * the intake documents, same env override for tests.
 */

const fs = require("fs");
const path = require("path");
const Book = require("../models/Book");
const Loan = require("../models/Loan");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const { LIBRARY, BOOK_SOURCES } = require("../utils/domain");
const lookup = require("./bookLookupService");

const DAY = 86400000;
const COVER_MIME_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_COVER_BYTES = lookup.MAX_COVER_BYTES;

/* ───────────────────────── files ───────────────────────── */

function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
}
const coverDir = (world) => path.join(uploadRoot(), world, "books");
/** Absolute path of a book's stored cover (null when none). */
function coverPath(book) {
  if (!book?.cover?.storedName) return null;
  return path.join(coverDir(book.world), book.cover.storedName);
}
function removeCover(book) {
  const p = coverPath(book);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  book.cover = undefined;
}
/** Validate + write a cover; the record keeps the metadata. */
function saveCover(book, cover) {
  const ext = COVER_MIME_EXT[String(cover?.mime || "").toLowerCase()];
  if (!ext || !cover.buffer?.length || cover.buffer.length > MAX_COVER_BYTES) throw AppError.of("COVER_INVALID", 400);
  removeCover(book);
  fs.mkdirSync(coverDir(book.world), { recursive: true });
  const storedName = `${book._id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(coverDir(book.world), storedName), cover.buffer);
  book.cover = { storedName, mime: cover.mime.toLowerCase(), size: cover.buffer.length, savedAt: new Date() };
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
 * A return DAY out of "YYYY-MM-DD" (preferred) or any date string — local
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
const openLoanOf = (world, bookId, session) =>
  Loan.findOne({ world, book: bookId, open: true }).session(session || null);

async function loadBook(world, bookId) {
  const book = await Book.findOne({ _id: bookId, world, deletedAt: null });
  if (!book) throw AppError.of("NOT_FOUND", 404, "ספר");
  return book;
}

/**
 * Add a book. `cover` is { mime, buffer } (a data URL the page sent, or
 * what the lookup downloaded); without one, `imageUrl` is fetched best-effort.
 */
async function createBook({ world, data, by, cover }) {
  const barcode = lookup.normalizeBarcode(data.barcode);
  if (!barcode) throw AppError.of("BARCODE_INVALID", 400);
  if (!data.title || !String(data.title).trim()) throw AppError.of("MISSING_FIELDS", 400, "title");

  // The same book under any spelling of its code (leading zeros, ISBN
  // twins) is the same record — refuse a live one, restore a deleted one.
  let book = await Book.findOne({ world, barcode: { $in: lookup.barcodeVariants(barcode) } });
  if (book && !book.deletedAt) throw AppError.of("BOOK_EXISTS", 409);
  if (book) {
    book.deletedAt = null; // a deleted book comes back with its history
  } else {
    book = new Book({ world, barcode });
  }
  assignFields(book, data);
  book.addedBy = by || book.addedBy;
  if (!data.source) book.source = "manual";

  if (cover) saveCover(book, cover);
  else if (data.imageUrl && data.fetchCover !== false) {
    try {
      const dl = await lookup.downloadCover(data.imageUrl);
      if (dl && COVER_MIME_EXT[dl.mime]) saveCover(book, dl);
    } catch {
      /* the cover is a nicety — the book is added without it */
    }
  }
  await book.save();
  return book;
}

async function updateBook({ world, bookId, data, by, cover, removeCoverFlag }) {
  const book = await loadBook(world, bookId);
  if (data.barcode !== undefined) {
    const barcode = lookup.normalizeBarcode(data.barcode);
    if (!barcode) throw AppError.of("BARCODE_INVALID", 400);
    if (barcode !== book.barcode) {
      const clash = await Book.findOne({ world, barcode: { $in: lookup.barcodeVariants(barcode) }, _id: { $ne: book._id } });
      if (clash) throw AppError.of("BOOK_EXISTS", 409);
      book.barcode = barcode;
    }
  }
  assignFields(book, data);
  if (data.title !== undefined && !book.title) throw AppError.of("MISSING_FIELDS", 400, "title");
  if (removeCoverFlag) removeCover(book);
  if (cover) saveCover(book, cover);
  await book.save();
  return book;
}

/** Soft delete — never while the book is out. */
async function deleteBook({ world, bookId }) {
  const book = await loadBook(world, bookId);
  if (await openLoanOf(world, book._id)) throw AppError.of("BOOK_ON_LOAN", 409);
  book.deletedAt = new Date();
  await book.save();
  return book;
}

/* ───────────────────────── loans ───────────────────────── */

async function lend({ world, bookId, studentId, dueAt, by, note }) {
  const book = await loadBook(world, bookId);
  if (!studentId) throw AppError.of("MISSING_FIELDS", 400, "student");
  const student = await Person.findOne({ _id: studentId, world, deletedAt: null });
  if (!student) throw AppError.of("NOT_FOUND", 404, "סטודנט/ית");
  const due = assertDueDate(parseDueDate(dueAt));

  const loan = await withTxn(async (session) => {
    if (await openLoanOf(world, book._id, session)) throw AppError.of("BOOK_ON_LOAN", 409);
    const doc = new Loan({
      world,
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

async function loadLoan(world, loanId) {
  const loan = await Loan.findOne({ _id: loanId, world });
  if (!loan) throw AppError.of("NOT_FOUND", 404, "השאלה");
  return loan;
}

/** הארכת זמן — a later return day; the old one is kept in `extensions`. */
async function extend({ world, loanId, dueAt, by, note }) {
  const loan = await loadLoan(world, loanId);
  if (!loan.open) throw AppError.of("LOAN_CLOSED", 409);
  const floor = new Date(Math.max(new Date(loan.dueAt).getTime(), startOfToday().getTime()));
  const due = assertDueDate(parseDueDate(dueAt), { after: floor });
  loan.extensions.push({ from: loan.dueAt, to: due, by, note: note ? String(note).trim() : undefined });
  loan.dueAt = due;
  loan.log.push({ action: "extended", by, note: note ? String(note).trim() : undefined });
  await loan.save();
  return loan;
}

/** החזרת ספר — closes the loan; the book is back on the shelf. */
async function returnBook({ world, loanId, by, note }) {
  const loan = await loadLoan(world, loanId);
  if (!loan.open) throw AppError.of("LOAN_CLOSED", 409);
  loan.open = false;
  loan.returnedAt = new Date();
  loan.returnedBy = by;
  loan.log.push({ action: "returned", by, note: note ? String(note).trim() : undefined });
  await loan.save();
  return loan;
}

module.exports = {
  uploadRoot,
  coverPath,
  parseDataUrl,
  saveCover,
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
