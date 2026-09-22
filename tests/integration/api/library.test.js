/**
 * הספרייה — the scan flow end to end: lookup (library first, then the
 * internet), add with a cover, lend / extend / return with Eden's rules
 * (one copy per book, no Fri/Shabbat return days), soft delete + restore,
 * world isolation.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// Covers go to a temp dir, never into server/uploads.
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shekel-library-"));

const request = require("supertest");
const app = require("../../../app");
const Loan = require("../../../models/Loan");
const Book = require("../../../models/Book");
const lookup = require("../../../services/bookLookupService");
const { makeStudent, makeBook } = require("../../helpers/factories");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

/** "YYYY-MM-DD" of a local day `n` days from today, moved off Fri/Shabbat when asked. */
function dayStr(n, { open = true } = {}) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  if (open) while (d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** The next Friday at least `n` days ahead. */
function fridayStr(n = 1) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const fakeNet = () =>
  lookup.setFetch(async (url) => {
    const respond = (status, body, type = "text/html") => ({
      ok: status < 300,
      status,
      headers: { get: () => type },
      text: async () => body,
      json: async () => JSON.parse(body),
      arrayBuffer: async () => body,
    });
    if (url.includes("%D7%97%D7%99%D7%A4%D7%95%D7%A9")) {
      return url.includes("36200054208")
        ? respond(200, '<a href="/מוצרים/%d7%94%d7%96%d7%95%d7%92-36200054208">x</a>')
        : respond(200, "<html>אין תוצאות</html>");
    }
    if (url.includes("/Images/")) return respond(200, PNG, "image/png");
    if (url.includes("36200054208")) {
      return respond(200, '<h1>הזוג מהבית השכן</h1><div class="pp-authors">שרי לפניה</div><h2>תקציר</h2><div>מותחן.</div>');
    }
    if (url.includes("googleapis")) return respond(200, "{}", "application/json");
    return respond(404, "");
  });

beforeEach(fakeNet);
afterAll(() => lookup.setFetch(null));

describe("GET /api/library/lookup/:barcode", () => {
  it("rejects junk", async () => {
    const res = await request(app).get("/api/library/lookup/abc");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BARCODE_INVALID");
  });

  it("unknown barcode → what booknet knows, with the cover as a data URL", async () => {
    const res = await request(app).get("/api/library/lookup/36200054208");
    expect(res.status).toBe(200);
    const { book, loan, info, failed } = res.body.data;
    expect(book).toBeNull();
    expect(loan).toBeNull();
    expect(failed).toBe(false);
    expect(info.source).toBe("booknet");
    expect(info.title).toBe("הזוג מהבית השכן");
    expect(info.author).toBe("שרי לפניה");
    expect(info.summary).toBe("מותחן.");
    expect(info.cover).toBe(DATA_URL);
  });

  it("unknown barcode nobody knows → info null (failed:false)", async () => {
    const res = await request(app).get("/api/library/lookup/9999999999");
    expect(res.body.data.info).toBeNull();
    expect(res.body.data.failed).toBe(false);
  });

  it("a library book → the record (+ its open loan), no internet call", async () => {
    let calls = 0;
    lookup.setFetch(async () => {
      calls++;
      throw new Error("must not be called");
    });
    const book = await makeBook({ barcode: "1234567890" });
    const res = await request(app).get("/api/library/lookup/123-456-7890");
    expect(res.status).toBe(200);
    expect(res.body.data.book._id).toBe(String(book._id));
    expect(res.body.data.loan).toBeNull();
    expect(calls).toBe(0);
  });

  it("the camera's leading zero still finds the shelf book (and the shop's book)", async () => {
    const book = await makeBook({ barcode: "36200054208" });
    for (const scanned of ["036200054208", "0036200054208", "36200054208"]) {
      const res = await request(app).get(`/api/library/lookup/${scanned}`);
      expect(res.body.data.book._id).toBe(String(book._id));
      expect(res.body.data.barcode).toBe("36200054208");
    }
    // Not in the library: booknet is asked without the zero, and the add
    // form gets the shop's form of the code.
    await Book.deleteMany({});
    const res = await request(app).get("/api/library/lookup/036200054208");
    expect(res.body.data.book).toBeNull();
    expect(res.body.data.info.title).toBe("הזוג מהבית השכן");
    expect(res.body.data.barcode).toBe("36200054208");
  });
});

describe("POST /api/library/books", () => {
  it("adds a book with its cover, then refuses the same barcode", async () => {
    const res = await request(app).post("/api/library/books").send({
      barcode: "36200054208",
      title: "הזוג מהבית השכן",
      author: "שרי לפניה",
      summary: "מותחן.",
      source: "booknet",
      productUrl: "https://www.booknet.co.il/x",
      coverData: DATA_URL,
      by: "נעה",
    });
    expect(res.status).toBe(201);
    const { book } = res.body.data;
    expect(book.title).toBe("הזוג מהבית השכן");
    expect(book.source).toBe("booknet");
    expect(book.addedBy).toBe("נעה");
    expect(book.cover.mime).toBe("image/png");
    expect(book.cover.size).toBe(PNG.length);
    // the bytes live in the record and a small cover rides inline with the book (never raw)
    expect(book.cover.data).toBeUndefined();
    expect(book.coverData).toBe(DATA_URL);
    const listed = (await request(app).get("/api/library/books")).body.data.books.find((b) => b._id === book._id);
    expect(listed.coverData).toBe(DATA_URL);

    const cover = await request(app).get(`/api/library/books/${book._id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers["content-type"]).toMatch(/image\/png/);
    expect(Number(cover.headers["content-length"])).toBe(PNG.length);

    const dupZero = await request(app).post("/api/library/books").send({ barcode: "036200054208", title: "כפול עם אפס" });
    expect(dupZero.status).toBe(409);
    expect(dupZero.body.code).toBe("BOOK_EXISTS");
    const dup = await request(app).post("/api/library/books").send({ barcode: "36200054208", title: "כפול" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("BOOK_EXISTS");
  });

  it("validates barcode, title and the cover", async () => {
    expect((await request(app).post("/api/library/books").send({ barcode: "x", title: "a" })).body.code).toBe("BARCODE_INVALID");
    expect((await request(app).post("/api/library/books").send({ barcode: "123456789" })).body.code).toBe("MISSING_FIELDS");
    const bad = await request(app).post("/api/library/books").send({ barcode: "123456789", title: "a", coverData: "data:text/plain;base64,aGk=" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("COVER_INVALID");
  });

  it("downloads the cover from imageUrl when no coverData was sent", async () => {
    const res = await request(app).post("/api/library/books").send({ barcode: "36200054208", title: "x", imageUrl: "https://www.booknet.co.il/Images/Site/Products/36200054208.jpg" });
    expect(res.status).toBe(201);
    expect(res.body.data.book.cover.mime).toBe("image/png");
  });
});

describe("lend / extend / return", () => {
  it("lends to a student for a valid day, one copy only, then returns", async () => {
    const book = await makeBook();
    const dana = await makeStudent({ firstName: "דנה" });
    const yossi = await makeStudent({ firstName: "יוסי" });

    // rules on the return day
    const past = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: dana._id, dueAt: dayStr(-1, { open: false }), by: "נעה" });
    expect(past.body.code).toBe("DUE_DATE_INVALID");
    const today = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: dana._id, dueAt: dayStr(0, { open: false }), by: "נעה" });
    expect(today.body.code).toBe("DUE_DATE_INVALID");
    const friday = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: dana._id, dueAt: fridayStr(), by: "נעה" });
    expect(friday.status).toBe(400);
    expect(friday.body.code).toBe("DUE_DATE_CLOSED");
    const far = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: dana._id, dueAt: dayStr(200), by: "נעה" });
    expect(far.body.code).toBe("DUE_DATE_TOO_FAR");
    const nobody = await request(app).post(`/api/library/books/${book._id}/lend`).send({ dueAt: dayStr(14), by: "נעה" });
    expect(nobody.body.code).toBe("MISSING_FIELDS");

    const due = dayStr(14);
    const ok = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: dana._id, dueAt: due, by: "נעה", note: "לקחה בכיתה" });
    expect(ok.status).toBe(201);
    const loan = ok.body.data.loan;
    expect(loan.open).toBe(true);
    expect(loan.student.firstName).toBe("דנה");
    expect(loan.book.title).toBe(book.title);
    expect(loan.log[0].action).toBe("lent");
    expect(new Date(loan.dueAt).getDay()).not.toBe(5);

    // one copy
    const second = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: yossi._id, dueAt: due, by: "נעה" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("BOOK_ON_LOAN");

    // the lookup now says who has it
    const look = await request(app).get(`/api/library/lookup/${book.barcode}`);
    expect(look.body.data.loan.student.firstName).toBe("דנה");

    // delete is refused while out
    expect((await request(app).delete(`/api/library/books/${book._id}`)).body.code).toBe("BOOK_ON_LOAN");

    // extend: must be later than the current day
    const earlier = await request(app).post(`/api/library/loans/${loan._id}/extend`).send({ dueAt: dayStr(7), by: "נעה" });
    expect(earlier.body.code).toBe("DUE_DATE_NOT_LATER");
    const same = await request(app).post(`/api/library/loans/${loan._id}/extend`).send({ dueAt: due, by: "נעה" });
    expect(same.body.code).toBe("DUE_DATE_NOT_LATER");
    const later = await request(app).post(`/api/library/loans/${loan._id}/extend`).send({ dueAt: dayStr(28), by: "חגי", note: "ביקשה עוד שבועיים" });
    expect(later.status).toBe(200);
    expect(later.body.data.loan.extensions).toHaveLength(1);
    expect(later.body.data.loan.extensions[0].by).toBe("חגי");
    expect(new Date(later.body.data.loan.dueAt) > new Date(loan.dueAt)).toBe(true);

    // return
    const back = await request(app).post(`/api/library/loans/${loan._id}/return`).send({ by: "נעה" });
    expect(back.status).toBe(200);
    expect(back.body.data.loan.open).toBe(false);
    expect(back.body.data.loan.returnedBy).toBe("נעה");
    expect(back.body.data.loan.log.map((l) => l.action)).toEqual(["lent", "extended", "returned"]);
    expect((await request(app).post(`/api/library/loans/${loan._id}/return`).send({ by: "נעה" })).body.code).toBe("LOAN_CLOSED");
    expect((await request(app).post(`/api/library/loans/${loan._id}/extend`).send({ dueAt: dayStr(40), by: "נעה" })).body.code).toBe("LOAN_CLOSED");

    // the shelf again: lend to the other student
    const again = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: yossi._id, dueAt: due, by: "נעה" });
    expect(again.status).toBe(201);

    // lists
    const open = await request(app).get("/api/library/loans?open=true");
    expect(open.body.results).toBe(1);
    expect(open.body.data.loans[0].student.firstName).toBe("יוסי");
    const ofDana = await request(app).get(`/api/library/loans?student=${dana._id}`);
    expect(ofDana.body.results).toBe(1);
    expect(ofDana.body.data.loans[0].open).toBe(false);
    const detail = await request(app).get(`/api/library/books/${book._id}`);
    expect(detail.body.data.loan.student.firstName).toBe("יוסי");
    expect(detail.body.data.history).toHaveLength(2);
  });

  it("refuses a student or book from another world", async () => {
    const book = await makeBook();
    const s = await makeStudent();
    const res = await request(app).post(`/api/library/books/${book._id}/lend`).set("X-Dataset", "test").send({ student: s._id, dueAt: dayStr(14), by: "x" });
    expect(res.status).toBe(404);
    const all = await request(app).get("/api/library/books").set("X-Dataset", "test");
    expect(all.body.results).toBe(0);
  });
});

describe("DELETE + restore", () => {
  it("soft-deletes a shelf book; re-adding its barcode restores it with its history", async () => {
    const book = await makeBook({ barcode: "5555555555" });
    const s = await makeStudent();
    const lent = await request(app).post(`/api/library/books/${book._id}/lend`).send({ student: s._id, dueAt: dayStr(10), by: "x" });
    await request(app).post(`/api/library/loans/${lent.body.data.loan._id}/return`).send({ by: "x" });

    expect((await request(app).delete(`/api/library/books/${book._id}`)).status).toBe(204);
    expect((await request(app).get("/api/library/books")).body.results).toBe(0);
    expect((await request(app).get("/api/library/lookup/5555555555")).body.data.book).toBeNull();

    const re = await request(app).post("/api/library/books").send({ barcode: "5555555555", title: "חזר למדף", by: "נעה" });
    expect(re.status).toBe(201);
    expect(re.body.data.book._id).toBe(String(book._id));
    expect(re.body.data.book.title).toBe("חזר למדף");
    expect(await Loan.countDocuments({ book: book._id })).toBe(1);
  });

  it("PATCH edits the details and can drop the cover", async () => {
    const created = await request(app).post("/api/library/books").send({ barcode: "777777777", title: "א", coverData: DATA_URL });
    const id = created.body.data.book._id;
    const up = await request(app).patch(`/api/library/books/${id}`).send({ title: "ב", author: "ג", year: "2020", removeCover: true, by: "נעה" });
    expect(up.status).toBe(200);
    expect(up.body.data.book.title).toBe("ב");
    expect(up.body.data.book.year).toBe(2020);
    expect(up.body.data.book.cover?.mime).toBeUndefined();
    expect(up.body.data.book.coverData).toBeUndefined();
    expect((await request(app).get(`/api/library/books/${id}/cover`)).status).toBe(404);
    expect((await request(app).patch(`/api/library/books/${id}`).send({ title: "" })).body.code).toBe("MISSING_FIELDS");
  });
});

describe("GET /api/meta/domain", () => {
  it("carries the library rules", async () => {
    const res = await request(app).get("/api/meta/domain");
    expect(res.body.data.domain.library.closedDays).toEqual([5, 6]);
    expect(res.body.data.domain.library.defaultLoanDays).toBe(14);
    expect(res.body.data.domain.bookSources.map((s) => s.key)).toEqual(["booknet", "google", "manual"]);
  });
});
