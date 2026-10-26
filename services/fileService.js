/**
 * @file fileService - a file's life in the bucket: begin, confirm, read, drop
 * @module services/fileService
 *
 * The S3 move (Eden, 2026-10-26; project-files/specs/files-s3-plan.html):
 *   1. beginUpload   the caller may write on this record? → a `files` row
 *                    in status "pending" with a storageKey nobody can
 *                    guess, and a signed PUT (5 minutes) the browser
 *                    uploads straight to the bucket with;
 *   2. confirmUpload HEAD in the bucket: there, the declared size, the
 *                    declared type (else the object and the row go);
 *                    then the row is "ready" and ATTACHED to its record
 *                    through the family's own function - the previous
 *                    file of that slot goes, the pending tag goes;
 *   3. signedRead    may the caller see this file? → a signed GET
 *                    (60 seconds) - the bucket is the only place bytes
 *                    live since stage 3 (2026-10-26);
 *   4. remove        a pending row (an upload that failed), or a ready
 *                    file through the family's own removal.
 *
 * Two kinds of caller: a signed-in persona (`{ req }` - fileAccess and the
 * lens decide) and a public link (`{ token }` - the link's own record is
 * the only thing it may touch). The FAMILY_RULES table holds, per family,
 * what a file may be, who may put it where, and how it hangs on its record.
 */

const { randomUUID } = require("crypto");
const mongoose = require("mongoose");
const StoredFile = require("../models/StoredFile");
const Intake = require("../models/Intake");
const Supplier = require("../models/Supplier");
const Voucher = require("../models/Voucher");
const Book = require("../models/Book");
const AppError = require("../utils/AppError");
const { FAMILIES } = require("../utils/auth");
const storage = require("./storage");
const storedFiles = require("./storedFiles");
const access = require("./fileAccess");
const lens = require("./lensService");
const intake = require("./intakeService");
const suppliers = require("./supplierService");
const personDocuments = require("./personDocumentService");
const invoices = require("./invoiceService");
const rounds = require("./invoiceRoundService");
const culture = require("./cultureService");
const library = require("./libraryService");

const isId = (v) => mongoose.isValidObjectId(v);
const clean = (s, max = 120) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);
const forbid = () => AppError.of("OUT_OF_SCOPE", 403);
const kindOk = (family, kind) => (FAMILIES[family] || []).includes(kind);

/** The acting persona's name for the audit trail (never from the body). */
const labelOf = (actor) => (actor.req ? actor.req.actor?.name || actor.req.account?.name || "" : "");

/* ───────────────────────── the families ─────────────────────────
 * accept(mime, name)       → { mime, ext } or null: what a file of this family may be
 * limit                    → the size cap
 * thumb                    → may carry a thumbnail
 * begin(actor, owner)      → the owner may be written on by this actor (throws), → the normalized owner
 * attach(file, ctx)        → the file hangs on its record → the family's answer (null = nothing to attach to yet)
 * detach(file, ctx)        → the file goes through the family's own removal
 */

async function staffPerson(req, personId) {
  if (!isId(personId)) throw AppError.of("NOT_FOUND", 404, "אדם");
  await lens.assertPerson(req, personId);
}

const FAMILY_RULES = {
  intake: {
    accept: (mime, name) => intake.fileKind(mime, name),
    limit: intake.MAX_FILE_BYTES,
    thumb: true,
    error: "DOCUMENT_INVALID",
    async begin(actor, owner) {
      if (!isId(owner.id)) throw AppError.of("NOT_FOUND", 404, "קליטה");
      if (actor.token) {
        if (actor.token.kind !== "intake" || String(actor.token.intake._id) !== String(owner.id)) throw forbid();
        intake.assertDocumentSlot({ key: owner.slot, staff: false, link: actor.token.link });
        return { kind: "intake", id: owner.id, slot: owner.slot };
      }
      const doc = await Intake.findById(owner.id).select("person").lean();
      if (!doc) throw AppError.of("NOT_FOUND", 404, "קליטה");
      await staffPerson(actor.req, doc.person);
      intake.assertDocumentSlot({ key: owner.slot, staff: true });
      return { kind: "intake", id: owner.id, slot: owner.slot };
    },
    async attach(file, { actor, meta }) {
      const doc = await Intake.findById(file.owner.id);
      if (!doc) throw AppError.of("NOT_FOUND", 404, "קליטה");
      const staff = !actor.token;
      const { moved } = await intake.attachDocument({ intake: doc, key: file.owner.slot, stored: file, by: labelOf(actor), staff, validUntil: meta.validUntil, signedAt: meta.signedAt, link: actor.token?.link || null });
      if (actor.token) return { view: intake.publicView(doc, actor.token.person, actor.token.link) };
      return { intake: await Intake.findById(doc._id).populate([{ path: "person" }, { path: "landing.preferences.subjects", select: "name category" }]), moved };
    },
    async detach(file, { actor }) {
      const doc = await Intake.findById(file.owner.id);
      if (!doc) return;
      if (actor.token) return intake.removeStudentDocument({ intake: doc, key: file.owner.slot });
      return intake.setDocumentStatus({ intake: doc, key: file.owner.slot, status: "missing", by: labelOf(actor) });
    },
  },
  suppliers: {
    accept: (mime, name) => intake.fileKind(mime, name),
    limit: suppliers.MAX_FILE_BYTES,
    thumb: true,
    error: "DOCUMENT_INVALID",
    async begin(actor, owner) {
      if (!isId(owner.id)) throw AppError.of("NOT_FOUND", 404, "ספק");
      if (actor.token) {
        if (actor.token.kind !== "supplier" || String(actor.token.supplier._id) !== String(owner.id)) throw forbid();
        suppliers.assertFileSlot(actor.token.supplier, owner.slot);
      } else {
        if (!kindOk("suppliers", actor.req.actor?.kind)) throw forbid();
        const s = await Supplier.findById(owner.id);
        if (!s) throw AppError.of("NOT_FOUND", 404, "ספק");
        suppliers.assertFileSlot(s, owner.slot);
      }
      return { kind: "supplier", id: owner.id, slot: owner.slot };
    },
    async attach(file, { actor }) {
      const s = actor.token ? actor.token.supplier : await Supplier.findById(file.owner.id);
      if (!s) throw AppError.of("NOT_FOUND", 404, "ספק");
      const saved = await suppliers.attachFile(s, { key: file.owner.slot, stored: file });
      return actor.token ? { view: suppliers.publicView(saved) } : { supplier: suppliers.staffView(saved) };
    },
    async detach(file, { actor }) {
      const s = actor.token ? actor.token.supplier : await Supplier.findById(file.owner.id);
      if (!s) return;
      return suppliers.removeFile(s, file.owner.slot);
    },
  },
  people: {
    accept: (mime, name) => intake.fileKind(mime, name),
    limit: intake.MAX_FILE_BYTES,
    thumb: true,
    error: "PERSON_DOCUMENT_INVALID",
    async begin(actor, owner) {
      if (actor.token) throw forbid();
      await staffPerson(actor.req, owner.id);
      await personDocuments.assertPerson(owner.id);
      return { kind: "person", id: owner.id };
    },
    async attach(file, { actor, meta }) {
      const document = await personDocuments.attach({ personId: file.owner.id, stored: file, kind: meta.kind, label: meta.label, note: meta.note, by: labelOf(actor) });
      return { document };
    },
    async detach(file) {
      const PersonDocument = require("../models/PersonDocument");
      const doc = await PersonDocument.findOne({ file: file._id }).select("_id person").lean();
      if (doc) await personDocuments.remove({ personId: doc.person, docId: doc._id });
      else await storedFiles.destroy(file._id);
    },
  },
  invoices: {
    accept: (mime) => invoices.acceptInvoiceFile(mime),
    limit: invoices.MAX_IMAGE_BYTES,
    thumb: true,
    error: "INVOICE_IMAGE_INVALID",
    async begin(actor, owner) {
      if (actor.token) {
        if (actor.token.kind !== "invoiceRequest") throw forbid();
        return { kind: "person", id: actor.token.request.teacher };
      }
      if (!kindOk("invoices", actor.req.actor?.kind)) throw forbid();
      await staffPerson(actor.req, owner.id);
      return { kind: "person", id: owner.id };
    },
    async attach(file, { actor, meta }) {
      if (actor.token) {
        const r = await rounds.addInvoice(actor.token.request, { stored: file, sessionIds: meta.sessions });
        return { view: await rounds.publicView(r) };
      }
      const scope = lens.scopeOf(actor.req);
      const cycleIds = await scope.cycleSet();
      const invoice = await invoices.createInvoice({ teacherId: file.owner.id, lessonIds: meta.lessons, stored: file, by: labelOf(actor), note: meta.note, cycleIds });
      return { invoice };
    },
    async detach(file, { actor }) {
      const Invoice = require("../models/Invoice");
      const inv = await Invoice.findOne({ file: file._id }).select("_id").lean();
      if (!inv) return storedFiles.destroy(file._id);
      if (actor.token) return rounds.removeInvoice(actor.token.request, inv._id);
      return invoices.deleteInvoice({ invoiceId: inv._id });
    },
  },
  culture: {
    accept: (mime) => culture.acceptVoucherImage(mime),
    limit: 8 * 1024 * 1024,
    thumb: true,
    error: "VOUCHER_IMAGE_INVALID",
    async begin(actor, owner) {
      if (actor.token || !kindOk("culture", actor.req.actor?.kind)) throw forbid();
      if (owner.id && !(await Voucher.exists({ _id: owner.id }))) throw AppError.of("NOT_FOUND", 404, "שובר");
      return { kind: "voucher", id: owner.id || undefined };
    },
    // a picture for a voucher that exists hangs on it now; one for a voucher still being made waits for POST /api/vouchers { imageFile }
    async attach(file) {
      if (!file.owner?.id) return null;
      const voucher = await culture.setVoucherImageFile({ voucherId: file.owner.id, fileId: file._id });
      return { voucher };
    },
    async detach(file) {
      const v = await Voucher.findOne({ image: file._id }).select("_id").lean();
      if (v) await Voucher.updateMany({ image: file._id }, { $set: { image: null } });
      await storedFiles.destroy(file._id);
    },
  },
  library: {
    accept: (mime) => library.acceptCover(mime),
    limit: library.MAX_COVER_BYTES,
    thumb: false,
    error: "COVER_INVALID",
    async begin(actor, owner) {
      if (actor.token || !kindOk("library", actor.req.actor?.kind)) throw forbid();
      if (owner.id && !(await Book.exists({ _id: owner.id }))) throw AppError.of("NOT_FOUND", 404, "ספר");
      return { kind: "book", id: owner.id || undefined };
    },
    async attach(file) {
      if (!file.owner?.id) return null;
      const book = await library.loadBook(file.owner.id);
      await library.saveCoverFile(book, file._id);
      await book.save();
      return { book };
    },
    async detach(file) {
      const book = await Book.findOne({ "cover.file": file._id });
      if (book) {
        book.cover = undefined;
        await book.save();
      }
      await storedFiles.destroy(file._id);
    },
  },
};
FAMILY_RULES.waiver = FAMILY_RULES.intake;

const ruleOf = (family) => {
  const r = FAMILY_RULES[family];
  if (!r) throw AppError.of("FILE_FAMILY_UNKNOWN", 400, String(family));
  return r;
};

/* ───────────────────────── the four steps ───────────────────────── */

/**
 * Step 1. → { fileId, storageKey, put: { url, method, headers, expiresAt }, thumbPut | null }
 * `owner` = { id, slot }; `size` is what the browser measured (checked against the bucket at confirm).
 */
async function beginUpload({ actor, family, owner = {}, name, mime, size, thumb = false }) {
  const rule = ruleOf(family);
  const kind = rule.accept(mime, name);
  const bytes = Number(size);
  if (!kind || !Number.isFinite(bytes) || bytes <= 0) throw AppError.of(rule.error, 400);
  if (bytes > rule.limit) throw AppError.of("FILE_TOO_LARGE", 413, `${Math.round(rule.limit / 1024 / 1024)}MB`);
  const own = await rule.begin(actor, { id: owner.id, slot: owner.slot ? String(owner.slot) : undefined });
  const storageKey = `${family}/${own.id || "new"}/${randomUUID()}`;
  const wantThumb = !!thumb && rule.thumb;
  const row = await StoredFile.create({
    name: clean(name) || `${own.slot || family}.${kind.ext}`,
    mime: kind.mime,
    size: bytes,
    status: "pending",
    storageKey,
    thumbKey: wantThumb ? `${storageKey}.thumb.jpg` : undefined,
    family,
    owner: own,
    uploadedBy: actor.token ? { token: actor.token.kind } : { account: actor.req.account?._id || undefined, label: labelOf(actor) },
  });
  const put = await storage.presignPut({ key: storageKey, mime: kind.mime });
  const thumbPut = wantThumb ? await storage.presignPut({ key: row.thumbKey, mime: "image/jpeg" }) : null;
  return { fileId: String(row._id), storageKey, put, thumbPut };
}

/** The pending row of this caller, or the typed refusal. */
async function pendingRow(actor, fileId) {
  const row = isId(fileId) && (await StoredFile.findById(fileId));
  if (!row) throw AppError.of("NOT_FOUND", 404, "קובץ");
  if (row.status !== "pending") throw AppError.of("FILE_NOT_PENDING", 409);
  const rule = ruleOf(row.family);
  await rule.begin(actor, { id: row.owner?.id, slot: row.owner?.slot });
  return { row, rule };
}

/**
 * Step 2. The bucket is asked what arrived; the row becomes "ready" and
 * hangs on its record. `meta` is the family's own: an intake document's
 * validUntil / signedAt, a person document's kind / label / note, an
 * invoice's lessons / note (or the link's sessions). → the family's answer.
 */
async function confirmUpload({ actor, fileId, meta = {} }) {
  const { row, rule } = await pendingRow(actor, fileId);
  const head = await storage.head(row.storageKey);
  if (!head) throw AppError.of("FILE_NOT_UPLOADED", 400);
  const mimeOk = !head.mime || head.mime === row.mime || head.mime === "application/octet-stream";
  if (head.size !== row.size || head.size > rule.limit || !mimeOk) {
    await storedFiles.destroy(row._id);
    throw AppError.of(head.size > rule.limit ? "FILE_TOO_LARGE" : "FILE_SIZE_MISMATCH", head.size > rule.limit ? 413 : 400);
  }
  if (row.thumbKey) {
    const th = await storage.head(row.thumbKey);
    if (!th || th.size <= 0 || th.size > storedFiles.MAX_THUMB_BYTES) {
      if (th) await storage.remove(row.thumbKey).catch(() => {});
      row.thumbKey = undefined;
    } else row.thumbSize = th.size;
  }
  row.status = "ready";
  await row.save();
  const out = await rule.attach(row, { actor, meta: meta || {} });
  if (out) await storedFiles.markAttached(row);
  return { fileId: String(row._id), attached: !!out, ...(out || {}) };
}

/** May this caller read the row? A signed-in persona through fileAccess; a link through its family rule. */
async function assertRead(actor, row) {
  if (actor.token) {
    await ruleOf(row.family).begin(actor, { id: row.owner?.id, slot: row.owner?.slot });
    return;
  }
  await access.assert(actor.req, row);
}

/** Step 3. → { url, expiresAt, mime, name, size } for the file or its thumbnail. */
async function signedRead({ actor, fileId, thumb = false, download = false }) {
  const row = isId(fileId) && (await StoredFile.findById(fileId));
  if (!row) throw AppError.of("NOT_FOUND", 404, "קובץ");
  if (row.status !== "ready") throw AppError.of("FILE_NOT_READY", 409);
  await assertRead(actor, row);
  const signed = await storedFiles.signedRead(row, { thumb, download });
  if (!signed) throw AppError.of("NOT_FOUND", 404, thumb ? "תמונה מוקטנת" : "קובץ");
  return signed;
}

/** Many at once (a list's thumbnails): { [id]: { url, expiresAt } } - an id the caller may not see is simply absent. */
async function signedReads({ actor, ids, thumb = false }) {
  const out = {};
  const wanted = [...new Set((ids || []).map(String).filter(isId))].slice(0, 200);
  const rows = await StoredFile.find({ _id: { $in: wanted }, status: "ready" });
  for (const row of rows) {
    try {
      await assertRead(actor, row);
      const signed = await storedFiles.signedRead(row, { thumb });
      if (signed) out[String(row._id)] = signed;
    } catch {
      /* not theirs, or no thumbnail - absent */
    }
  }
  return out;
}

/** Step 4. A pending row goes with its objects; a ready one goes the family's way. */
async function remove({ actor, fileId }) {
  const row = isId(fileId) && (await StoredFile.findById(fileId));
  if (!row) throw AppError.of("NOT_FOUND", 404, "קובץ");
  const rule = ruleOf(row.family);
  await rule.begin(actor, { id: row.owner?.id, slot: row.owner?.slot });
  if (row.status === "pending" || !row.attachedAt) return storedFiles.destroy(row._id);
  return rule.detach(row, { actor });
}

module.exports = { FAMILY_RULES, beginUpload, confirmUpload, signedRead, signedReads, remove };
