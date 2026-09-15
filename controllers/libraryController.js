/**
 * @file Library controller — הספרייה: the scan flow, books and loans
 * @module controllers/libraryController
 *
 * The scan flow the page runs (Eden, 2026-09-09):
 *   GET /lookup/:barcode → is the book in the library? with whom?
 *                          not here → what the internet knows (booknet /
 *                          Google Books) so "הוספה" is one tap.
 *   POST /books          → add it (details + the cover the lookup found)
 *   POST /books/:id/lend → "השאל ל…" (student + return day)
 *   POST /loans/:id/extend | /return → the two buttons of a lent book
 *
 * Every transition goes through services/libraryService; `by` is the
 * acting persona's name (no auth yet), like the rest of the app.
 */

const Book = require("../models/Book");
const Loan = require("../models/Loan");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const library = require("../services/libraryService");
const lookup = require("../services/bookLookupService");

const STUDENT_POP = { path: "student", select: "firstName lastName phone avatar deletedAt" };
const BOOK_POP = { path: "book", select: "title author barcode cover deletedAt" };

/** The cover a lookup downloaded → a data URL the page can preview and send back. */
const toDataUrl = (cover) => (cover ? `data:${cover.mime};base64,${cover.buffer.toString("base64")}` : null);

/** { mime, buffer } out of a request's coverData (or undefined). */
const coverOf = (body) => (body.coverData ? library.parseDataUrl(body.coverData) : undefined);

/** GET /api/library/books?q= — every live book of the world. */
exports.getBooks = catchAsync(async (req, res) => {
  const filter = { world: req.world, deletedAt: null };
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { author: rx }, { barcode: rx }];
  }
  const books = await Book.find(filter).sort({ title: 1 });
  res.status(200).json({ status: "success", results: books.length, data: { books } });
});

/** GET /api/library/books/:id → { book, loan (open), history } */
exports.getBook = catchAsync(async (req, res) => {
  const book = await library.loadBook(req.world, req.params.id);
  const [loan, history] = await Promise.all([
    Loan.findOne({ world: req.world, book: book._id, open: true }).populate(STUDENT_POP),
    Loan.find({ world: req.world, book: book._id }).populate(STUDENT_POP).sort({ loanedAt: -1 }).limit(30),
  ]);
  res.status(200).json({ status: "success", data: { book, loan, history } });
});

/**
 * GET /api/library/lookup/:barcode — the scan's first question.
 * → { barcode, book, loan, info, failed }: `book` when the library has it
 *   (+ its open `loan`), else `info` = what the internet knows (null when
 *   nothing; `failed` = every source errored, so nothing is certain).
 */
exports.lookupBarcode = catchAsync(async (req, res, next) => {
  // Every form the scan may have taken (leading zeros, UPC/EAN padding,
  // ISBN twins) — a book stored as 36200054208 answers to "036200054208".
  const variants = lookup.barcodeVariants(req.params.barcode);
  if (!variants.length) return next(AppError.of("BARCODE_INVALID", 400));
  const book = await Book.findOne({ world: req.world, barcode: { $in: variants }, deletedAt: null });
  if (book) {
    const loan = await Loan.findOne({ world: req.world, book: book._id, open: true }).populate(STUDENT_POP);
    return res.status(200).json({ status: "success", data: { barcode: book.barcode, book, loan, info: null, failed: false } });
  }
  const online = req.query.online === "false" ? { found: false, failed: false } : await lookup.lookupBook(variants[0]);
  // The form to store: what the shop recognised, else the canonical one.
  const barcode = online.found ? online.barcode : lookup.canonicalBarcode(variants[0]);
  const info = online.found
    ? {
        source: online.source,
        title: online.title,
        author: online.author,
        summary: online.summary,
        imageUrl: online.imageUrl,
        productUrl: online.productUrl,
        publisher: online.publisher || null,
        year: online.year || null,
        pages: online.pages || null,
        cover: toDataUrl(online.cover),
      }
    : null;
  res.status(200).json({ status: "success", data: { barcode, book: null, loan: null, info, failed: !!online.failed } });
});

/** POST /api/library/books — { barcode*, title*, author, summary, …, imageUrl, coverData, source, by } */
exports.createBook = catchAsync(async (req, res) => {
  const book = await library.createBook({ world: req.world, data: req.body, by: req.body.by, cover: coverOf(req.body) });
  res.status(201).json({ status: "success", data: { book } });
});

/** PATCH /api/library/books/:id — { …fields, coverData?, removeCover?, by } */
exports.updateBook = catchAsync(async (req, res) => {
  const book = await library.updateBook({
    world: req.world,
    bookId: req.params.id,
    data: req.body,
    by: req.body.by,
    cover: coverOf(req.body),
    removeCoverFlag: req.body.removeCover === true,
  });
  res.status(200).json({ status: "success", data: { book } });
});

/** DELETE /api/library/books/:id — soft; refused while on loan. */
exports.deleteBook = catchAsync(async (req, res) => {
  await library.deleteBook({ world: req.world, bookId: req.params.id });
  res.status(204).json({ status: "success", data: null });
});

/** GET /api/library/books/:id/cover — the stored image, inline. */
exports.getCover = catchAsync(async (req, res, next) => {
  const book = await Book.findOne({ _id: req.params.id, world: req.world });
  const file = book && library.coverPath(book);
  if (!file) return next(AppError.of("NOT_FOUND", 404, "כריכה"));
  res.set("Cache-Control", "private, max-age=86400");
  res.type(book.cover.mime);
  res.sendFile(file, (err) => err && next(AppError.of("NOT_FOUND", 404, "כריכה")));
});

/** GET /api/library/loans?open=true|false&student=&book= */
exports.getLoans = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.open === "true") filter.open = true;
  if (req.query.open === "false") filter.open = false;
  if (req.query.student) filter.student = req.query.student;
  if (req.query.book) filter.book = req.query.book;
  const loans = await Loan.find(filter).populate([STUDENT_POP, BOOK_POP]).sort({ open: -1, dueAt: 1, loanedAt: -1 });
  res.status(200).json({ status: "success", results: loans.length, data: { loans } });
});

/** POST /api/library/books/:id/lend — { student*, dueAt* (YYYY-MM-DD), by, note } */
exports.lend = catchAsync(async (req, res) => {
  const loan = await library.lend({
    world: req.world,
    bookId: req.params.id,
    studentId: req.body.student,
    dueAt: req.body.dueAt,
    by: req.body.by,
    note: req.body.note,
  });
  res.status(201).json({ status: "success", data: { loan: await loan.populate([STUDENT_POP, BOOK_POP]) } });
});

/** POST /api/library/loans/:id/extend — { dueAt*, by, note } */
exports.extend = catchAsync(async (req, res) => {
  const loan = await library.extend({ world: req.world, loanId: req.params.id, dueAt: req.body.dueAt, by: req.body.by, note: req.body.note });
  res.status(200).json({ status: "success", data: { loan: await loan.populate([STUDENT_POP, BOOK_POP]) } });
});

/** POST /api/library/loans/:id/return — { by, note } */
exports.returnBook = catchAsync(async (req, res) => {
  const loan = await library.returnBook({ world: req.world, loanId: req.params.id, by: req.body.by, note: req.body.note });
  res.status(200).json({ status: "success", data: { loan: await loan.populate([STUDENT_POP, BOOK_POP]) } });
});
