/**
 * @file librarySeed — a small demo library for the test world
 * @module scripts/lib/librarySeed
 *
 * Twelve Hebrew titles on the shelf, built through the REAL services
 * (libraryService.createBook / lend / extend / returnBook), then the loan
 * dates are slid so the page opens with something to look at:
 *
 *   on the shelf      — most of the books
 *   with a student    — due in ten days; due tomorrow; one already
 *                       extended once; one OVERDUE by a week
 *   returned history  — a few closed loans, so a book's history reads well
 *
 * Covers: the one barcode Eden's notebook used (36200054208) is fetched
 * from booknet best-effort (the seed works offline — the page draws a
 * flat placeholder cover for books without an image).
 * Deterministic; no PRNG.
 */

const Loan = require("../../models/Loan");
const library = require("../../services/libraryService");
const lookup = require("../../services/bookLookupService");

const DAY = 86400000;

/** Local "YYYY-MM-DD" of a day `n` days ahead, moved off Fri/Shabbat. */
function openDay(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  while (d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight `n` days from today (any weekday — used for past dates). */
function dayAt(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

const BOOKS = [
  { barcode: "36200054208", title: "הזוג מהבית השכן", author: "שרי לפניה", summary: "אן ומרקו, זוג צעיר עם תינוקת, מוזמנים לארוחת ערב אצל השכנים ומשאירים אותה לבד בבית. כשהם חוזרים — היא נעלמה. מותחן פסיכולוגי מלא תפניות.", source: "booknet", productUrl: "https://www.booknet.co.il/מוצרים/הזוג-מהבית-השכן-36200054208", imageUrl: "https://www.booknet.co.il/Images/Site/Products/36200054208.jpg" },
  { barcode: "36200011001", title: "הנסיך הקטן", author: "אנטואן דה סנט־אכזופרי", summary: "טייס שנוחת במדבר פוגש נסיך קטן מכוכב רחוק, ולומד ממנו מה באמת חשוב — ומה רואים רק בלב.", source: "manual" },
  { barcode: "36200011002", title: "אליס בארץ הפלאות", author: "לואיס קרול", summary: "אליס רודפת אחרי ארנב לבן ונופלת לעולם שבו החתולים מחייכים, המלכה כועסת והזמן תמיד עוצר לתה.", source: "manual" },
  { barcode: "36200011003", title: "פו הדב", author: "א.א. מילן", summary: "הרפתקאותיו של דוב אוהב דבש וחבריו ביער מאה העצים — חזרזיר, איה, ינשוף וכריסטופר רובין.", source: "manual" },
  { barcode: "36200011004", title: "המסע אל הים", author: "רונית מטלון", summary: "סיפור מסע קצר על משפחה, זיכרון ומה שנשאר מאחור.", source: "manual" },
  { barcode: "36200011005", title: "דירה להשכיר", author: "לאה גולדברג", summary: "בבניין בן חמש קומות מתפנה דירה, והדיירים בוחרים שכן חדש — סיפור מחורז על חברות וקבלת האחר.", source: "manual" },
  { barcode: "36200011006", title: "מיץ פטל", author: "חיה שנהב", summary: "יום אחד מגיע מיץ פטל לביתם של החיות, וכולם רוצים להיות חברים שלו.", source: "manual" },
  { barcode: "36200011007", title: "הארי פוטר ואבן החכמים", author: "ג'יי קיי רולינג", summary: "ביום הולדתו האחד־עשר מגלה הארי שהוא קוסם, ומתחיל את לימודיו בהוגוורטס — בית הספר לכישוף ולקוסמות.", source: "manual" },
  { barcode: "36200011008", title: "בישול ביתי לכל השבוע", author: "רות סירקיס", summary: "מתכונים פשוטים למטבח של כל יום — מרקים, תבשילים, מאפים ועוגות, עם צילומים והסברים שלב אחר שלב.", source: "manual" },
  { barcode: "36200011009", title: "אטלס העולם לילדים", author: "הוצאת מפה", summary: "מפות צבעוניות של כל היבשות, דגלים, חיות ואוצרות טבע — ספר עיון ראשון בגאוגרפיה.", source: "manual" },
  { barcode: "36200011010", title: "ספר הג'ונגל", author: "רודיארד קיפלינג", summary: "מוגלי, ילד שגדל בין הזאבים, לומד את חוקי הג'ונגל בעזרת הדב באלו והפנתר בגירה.", source: "manual" },
  { barcode: "36200011011", title: "שירים לילדים", author: "ע. הלל", summary: "מבחר שירים מצחיקים ומתוקים — 'דודי שמחה', 'למה לובשת הזברה פיג'מה' ועוד.", source: "manual" },
];

/**
 * @param {object} o
 * @param {string}   o.world
 * @param {object[]} o.students   people (docs or ids) to lend to — at least 6
 * @param {string}   [o.by]       persona name stamped on the loans
 * @param {boolean}  [o.online]   try to download the real cover of the booknet title
 * @param {Function} [o.log]
 */
async function seedLibrary({ world, students, by = "נעה", online = true, log = () => {} }) {
  if (!students || students.length < 6) throw new Error("seedLibrary needs at least 6 students");
  const id = (s) => String(s._id || s);

  // covers: one real download, best effort
  const books = [];
  for (const b of BOOKS) {
    let cover;
    if (online && b.source === "booknet") {
      try {
        cover = await lookup.downloadCover(b.imageUrl);
      } catch {
        cover = null;
      }
    }
    const book = await library.createBook({ world, data: { ...b, fetchCover: false }, by, cover: cover || undefined });
    books.push(book);
  }
  log(`  library: ${books.length} books (${books.filter((b) => b.cover?.storedName).length} with a cover)`);

  /** lend, then slide the dates so the loan looks `age` days old, due `due` days from today. */
  const lentAgo = async (book, student, { age, due, note }) => {
    const loan = await library.lend({ world, bookId: book._id, studentId: id(student), dueAt: openDay(Math.max(due, 1)), by, note });
    const patch = { loanedAt: dayAt(-age) };
    if (due < 1) patch.dueAt = dayAt(due); // an overdue day (may be any weekday in the past)
    await Loan.updateOne({ _id: loan._id }, { $set: patch, "log.0.at": dayAt(-age) });
    return Loan.findById(loan._id);
  };
  const returnedAgo = async (book, student, { age, kept }) => {
    const loan = await lentAgo(book, student, { age, due: 14 });
    await library.returnBook({ world, loanId: loan._id, by });
    await Loan.updateOne({ _id: loan._id }, { $set: { returnedAt: dayAt(-age + kept), dueAt: dayAt(-age + 14), "log.1.at": dayAt(-age + kept) } });
  };

  // history first (closed loans), then the open ones
  await returnedAgo(books[1], students[0], { age: 60, kept: 12 });
  await returnedAgo(books[1], students[3], { age: 35, kept: 9 });
  await returnedAgo(books[7], students[1], { age: 40, kept: 14 });
  await returnedAgo(books[10], students[4], { age: 21, kept: 6 });

  await lentAgo(books[7], students[2], { age: 4, due: 10, note: "לקח אחרי השיעור" });
  await lentAgo(books[2], students[4], { age: 13, due: 1 });
  await lentAgo(books[0], students[5], { age: 21, due: -7, note: "להזכיר בטלפון" });
  const extended = await lentAgo(books[5], students[1], { age: 16, due: 5 });
  await library.extend({ world, loanId: extended._id, dueAt: openDay(19), by, note: "ביקשה עוד שבועיים" });
  await Loan.updateOne({ _id: extended._id }, { $set: { "extensions.0.at": dayAt(-2), "log.1.at": dayAt(-2) } });

  const open = await Loan.countDocuments({ world, open: true });
  const closed = await Loan.countDocuments({ world, open: false });
  log(`  library: ${open} open loans (one overdue, one extended) · ${closed} returned`);
  return { books, open, closed };
}

module.exports = { seedLibrary, BOOKS };
