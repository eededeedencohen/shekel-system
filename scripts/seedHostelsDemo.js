/**
 * @file seedHostelsDemo - שמרית's round in the TEST world (Eden, 2026-10-19:
 * "תעשה לי נתוני טסטים (שם המשפחה יהיה טסט) וגם תיצור לי סתם קבצים ותשמור
 * כדי שאראה בדיוק את הדברים").
 *
 * What it plants (world:"test", every person "טסט"):
 *   · הוסטל טסט (kind hostel, three contacts) and קהילת טסט (community, two)
 *   · three teachers of the hostels - אביה, עומר, and נועה who has no course yet
 *   · eight residents of the hostel (dates), one who left, three members of
 *     the community; two residents also in מכללה לכל (the combined tag)
 *   · three live courses with weekly slots, seats for most residents (two
 *     left out - "הוסף את כל דיירי ההוסטל" has someone to add), and the
 *     last six weeks of lessons with attendance
 *   · the invoice round of last month: אביה marked her sessions, uploaded
 *     an invoice picture and finished; עומר opened his link and stopped
 *   · last month's attendance drafts from the houses (phase 3): דני of
 *     הוסטל טסט marked three sessions with absence reasons, named someone
 *     not on the list and someone who left, and finished; שמרית approved
 *     one session. קהילת טסט ב got its link and did not open it
 *   · papers: אביה's syllabus (a PDF), עומר's certificate (a picture)
 *   · אביה's supplier file, linked to her, with the form filled
 *   · שמרית's diary (and Eden's): overdue tasks, today's, a note ahead
 *
 * Re-runnable: it remembers what it created (server/backups/seed-hostels-demo.json,
 * gitignored) and removes exactly those rows first - never anything else.
 *
 * Usage:  node scripts/seedHostelsDemo.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const Subject = require("../models/Subject");
const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const Invoice = require("../models/Invoice");
const InvoiceLesson = require("../models/InvoiceLesson");
const InvoiceRound = require("../models/InvoiceRound");
const InvoiceRequest = require("../models/InvoiceRequest");
const HostelReport = require("../models/HostelReport");
const PersonDocument = require("../models/PersonDocument");
const Supplier = require("../models/Supplier");
const DiaryEntry = require("../models/DiaryEntry");
const StoredFile = require("../models/StoredFile");
const { PersonTag, PersonTagEvent } = require("../models/PersonTag");
const CycleTag = require("../models/CycleTag");
const StaffAccount = require("../models/StaffAccount");
const { createPersonWithProfile } = require("../services/profileService");
const tags = require("../services/tagService");
const rounds = require("../services/invoiceRoundService");
const reports = require("../services/hostelReportService");
const documents = require("../services/personDocumentService");
const suppliers = require("../services/supplierService");
const { SUBJECT_CATEGORY_KEYS } = require("../utils/domain");

const WORLD = "test";
const LEDGER = path.join(__dirname, "..", "backups", "seed-hostels-demo.json");
const DAY = 86400000;
const utc = (key) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d) => new Date(d).toISOString().slice(0, 10);
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ───────────────────── deterministic randomness ───────────────────── */
let seed = 20261019;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/* ───────────────────── files made by hand: a PNG, a PDF ───────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/**
 * A picture that reads as a paper: white sheet, a dark header band, a
 * coloured mark, rows of grey "text" lines and a framed box at the bottom
 * (an invoice's total). `tint` = [r,g,b] of the mark; `rows` how many lines.
 */
function makePng({ width = 600, height = 800, tint = [78, 59, 120], rows = 9, label = 0 } = {}) {
  const px = Buffer.alloc(width * height * 3, 255);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  };
  const ink = [27, 26, 23];
  const grey = [190, 186, 176];
  const soft = [232, 229, 220];
  rect(0, 0, width, 70, ink); // the header band
  rect(width - 110, 18, 80, 34, tint); // the mark (a logo's place)
  rect(30, 100, width - 60, 2, grey);
  for (let r = 0; r < rows; r++) {
    const y = 130 + r * 44;
    const w = Math.round((width - 60) * (0.45 + ((r * 37 + label * 11) % 50) / 100));
    rect(width - 30 - w, y, w, 12, r % 3 === 0 ? ink : grey); // right-aligned "lines"
    rect(30, y, 70, 12, soft);
  }
  const boxY = height - 160;
  rect(30, boxY, width - 60, 2, ink);
  rect(30, boxY + 20, width - 60, 90, soft);
  rect(width - 230, boxY + 50, 180, 24, tint);
  // a small number-like mark that differs per picture
  for (let i = 0; i <= label; i++) rect(40 + i * 18, boxY + 50, 10, 24, ink);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    px.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-page PDF with a few lines of (Latin) text - a syllabus's stand-in. */
function makePdf(lines) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT /F1 22 Tf 60 760 Td (" + esc(lines[0]) + ") Tj ET\n";
  lines.slice(1).forEach((l, i) => {
    content += `BT /F1 13 Tf 60 ${715 - i * 24} Td (${esc(l)}) Tj ET\n`;
  });
  content += "0.31 0.23 0.47 RG 2 w 60 740 m 535 740 l S\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

/* ───────────────────── the ledger: what an earlier run made ───────────────────── */

const MODELS = { people: Person, profiles: Profile, subjects: Subject, hostels: Hostel, cycles: Cycle, enrollments: Enrollment, lessons: Lesson, invoices: Invoice, invoiceLessons: InvoiceLesson, invoiceRounds: InvoiceRound, invoiceRequests: InvoiceRequest, hostelReports: HostelReport, personDocuments: PersonDocument, suppliers: Supplier, diaryEntries: DiaryEntry, files: StoredFile, personTags: PersonTag, cycleTags: CycleTag };

async function removeEarlierRun() {
  if (!fs.existsSync(LEDGER)) return;
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return;
  }
  const report = [];
  // the invoice rows written on the ledger's invoices and lessons go first - the loop below deletes the invoices and the
  // lessons themselves, and a row left behind pointed at nothing (139 of them in the test world by 2026-10-22, found by
  // the super admin's orphan check)
  const ledgerInvoices = ledger.ids?.invoices || [];
  const ledgerLessons = ledger.ids?.lessons || [];
  if (ledgerInvoices.length || ledgerLessons.length) {
    const r = await InvoiceLesson.deleteMany({ $or: [{ invoice: { $in: ledgerInvoices } }, { lesson: { $in: ledgerLessons } }] });
    report.push(`invoiceLessons (ledger) ${r.deletedCount}`);
  }
  for (const [name, ids] of Object.entries(ledger.ids || {})) {
    const Model = MODELS[name];
    if (!Model || !ids.length) continue;
    const r = await Model.deleteMany({ _id: { $in: ids }, world: WORLD });
    report.push(`${name} ${r.deletedCount}`);
  }
  // the rows other services made FOR our people and cycles (tags, lesson rows the link created, invoice rows)
  const people = ledger.ids?.people || [];
  const cycles = ledger.ids?.cycles || [];
  if (people.length) {
    const rows = await PersonTag.find({ person: { $in: people } }).select("_id").lean();
    await PersonTagEvent.deleteMany({ personTag: { $in: rows.map((r) => r._id) } });
    report.push(`personTags ${(await PersonTag.deleteMany({ _id: { $in: rows.map((r) => r._id) } })).deletedCount}`);
  }
  if (cycles.length) {
    report.push(`cycleTags ${(await CycleTag.deleteMany({ cycle: { $in: cycles } })).deletedCount}`);
    const lessons = await Lesson.find({ cycle: { $in: cycles }, world: WORLD }).select("_id").lean();
    const lids = lessons.map((l) => l._id);
    report.push(`invoiceLessons ${(await InvoiceLesson.deleteMany({ lesson: { $in: lids } })).deletedCount}`);
    report.push(`lessons ${(await Lesson.deleteMany({ _id: { $in: lids } })).deletedCount}`);
    report.push(`enrollments ${(await Enrollment.deleteMany({ cycle: { $in: cycles }, world: WORLD })).deletedCount}`);
  }
  if (people.length) {
    const invs = await Invoice.find({ teacher: { $in: people }, world: WORLD }).select("_id file").lean();
    if (invs.length) {
      await InvoiceLesson.deleteMany({ invoice: { $in: invs.map((i) => i._id) } });
      await StoredFile.deleteMany({ _id: { $in: invs.map((i) => i.file) } });
      report.push(`invoices ${(await Invoice.deleteMany({ _id: { $in: invs.map((i) => i.file ? i._id : i._id) } })).deletedCount}`);
    }
    const sups = await Supplier.find({ person: { $in: people }, world: WORLD });
    for (const s of sups) await suppliers.remove(s);
    const docs = await PersonDocument.find({ person: { $in: people }, world: WORLD }).select("file").lean();
    await StoredFile.deleteMany({ _id: { $in: docs.map((d) => d.file) } });
    await PersonDocument.deleteMany({ person: { $in: people }, world: WORLD });
    await Profile.deleteMany({ person: { $in: people } });
  }
  console.log(`Removed the earlier run: ${report.join(" · ")}`);
  fs.unlinkSync(LEDGER);
}

/* ───────────────────── the seed ───────────────────── */

async function main() {
  await connectDB();
  await removeEarlierRun();
  await tags.ensureCatalog(WORLD);
  const ids = Object.fromEntries(Object.keys(MODELS).map((k) => [k, []]));
  const now = new Date();
  // the ledger is written after every row, so a run that stops halfway still leaves what to remove
  const writeLedger = () => {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ at: now.toISOString(), world: WORLD, ids }, null, 2));
  };
  const note = (name, doc) => {
    ids[name].push(String(doc._id));
    writeLedger();
    return doc;
  };
  const today = localDay(now);
  const by = "שמרית";

  /* 1 ── subjects of the test world */
  const cat = (k) => (SUBJECT_CATEGORY_KEYS.includes(k) ? k : SUBJECT_CATEGORY_KEYS[0]);
  const subjects = {};
  for (const [name, category] of [["עיצוב גרפי", "media"], ["מוסיקה", "music"], ["יוגה", "movement"]]) {
    subjects[name] = note("subjects", await Subject.create({ world: WORLD, name, category: cat(category), active: true }));
  }

  /* 2 ── the houses */
  const hostel = note(
    "hostels",
    await Hostel.create({
      world: WORLD,
      name: "טסט",
      kind: "hostel",
      address: "רחוב הדוגמה 12",
      city: "ירושלים",
      phone: "02-5550101",
      email: "hostel.test@example.org",
      // the Ministry's numbers (her file): approvals and when the activity began
      approvals: 12,
      since: new Date(now.getFullYear() - 4, 5, 1),
      contacts: [
        { name: "יונית טסט", role: "manager", phone: "050-5550001" },
        { name: "דני טסט", role: "reporter", phone: "050-5550002", email: "dani.test@example.org" },
        { name: "רוני טסט", role: "coordinator", phone: "050-5550003" },
      ],
      notes: "הקבוצה נפגשת בסלון הגדול; כשהשער סגור מתקשרים לדני.",
    })
  );
  const community = note(
    "hostels",
    await Hostel.create({
      world: WORLD,
      name: "טסט ב",
      kind: "community",
      address: "שדרות הניסיון 3",
      city: "ירושלים",
      phone: "02-5550202",
      contacts: [
        { name: "מיכל טסט", role: "manager", phone: "050-5550011" },
        { name: "אסף טסט", role: "reporter", phone: "050-5550012" },
      ],
      notes: "דיור עצמאי - המשתתפים מגיעים לפעילות בימי שלישי.",
    })
  );

  /* 3 ── teachers */
  const teacher = async (firstName, gender, phone, subjectNames, hostelRate) => {
    const { person, profile } = await createPersonWithProfile("Teacher", {
      world: WORLD,
      firstName,
      lastName: "טסט",
      gender,
      phone,
      email: `teacher_${ids.people.length + 1}@test.local`,
      subjects: subjectNames.map((n) => subjects[n]._id),
      hostelRate,
    });
    note("people", person);
    note("profiles", profile);
    await tags.give({ world: WORLD, personId: person._id, key: "hostels", by, note: "נוסף/ה למורי ההוסטלים" });
    return person;
  };
  const avia = await teacher("אביה", "female", "052-5551001", ["עיצוב גרפי", "יוגה"], 250);
  const omer = await teacher("עומר", "male", "052-5551002", ["מוסיקה"], 400);
  const noa = await teacher("נועה", "female", "052-5551003", ["מוסיקה"], 200);

  /* 4 ── students: residents, one who left, the community's members */
  const student = async (firstName, gender, residence, extraTags = []) => {
    const { person, profile } = await createPersonWithProfile(
      "StudentCollege",
      {
        world: WORLD,
        firstName,
        lastName: "טסט",
        gender,
        phone: `053-555${String(2000 + ids.people.length).slice(-4)}`,
        birthDate: new Date(1985 + (ids.people.length % 20), ids.people.length % 12, 10),
        pipeline: { stage: "Placed", since: new Date(now - 200 * DAY) },
        stageHistory: [{ stage: "Placed", movedAt: new Date(now - 200 * DAY), movedBy: by, note: "נתוני טסט" }],
        residence,
        notes: "סטודנט/ית בדיקה - לא אמיתי/ת",
        import: { registrationSource: "נתוני טסט הוסטלים" },
      },
      { trusted: true }
    );
    note("people", person);
    note("profiles", profile);
    await tags.give({ world: WORLD, personId: person._id, key: "hostels", by });
    for (const k of extraTags) await tags.give({ world: WORLD, personId: person._id, key: k, by });
    return person;
  };
  const sinceAgo = (days) => new Date(now - days * DAY);
  const residents = [];
  const names = [["רועי", "male", 400], ["מאיה", "female", 380], ["יובל", "male", 300], ["שירה", "female", 260], ["איתי", "male", 200], ["תמר", "female", 150], ["נדב", "male", 90], ["ליאור", "female", 30]];
  for (const [i, [n, g, days]] of names.entries()) {
    residents.push(await student(n, g, { hostel: hostel._id, label: "הוסטל טסט", since: sinceAgo(days) }, i < 2 ? ["college"] : []));
  }
  await student("גיל", "male", { hostel: hostel._id, label: "הוסטל טסט", since: sinceAgo(500), until: sinceAgo(20) });
  const members = [];
  for (const [n, g, days] of [["אורי", "male", 120], ["הדר", "female", 100], ["עדי", "female", 60]]) {
    members.push(await student(n, g, { hostel: community._id, label: "קהילת טסט ב", since: sinceAgo(days) }));
  }

  /* 5 ── courses with weekly slots, seats, lessons */
  const startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const endDate = new Date(now.getFullYear() + 1, 5, 30);
  const course = async (subjectName, teacherDoc, house, slot) => {
    const c = note("cycles", await Cycle.create({ world: WORLD, subject: subjects[subjectName]._id, teacher: teacherDoc._id, status: "Active", startDate, endDate, hostel: house._id, venue: { hostel: house._id, label: "הסלון" }, schedule: [slot], matching: { enrollmentOpen: true } }));
    await tags.setCycleProgram({ world: WORLD, cycleId: c._id, key: "hostels" });
    return c;
  };
  const design = await course("עיצוב גרפי", avia, hostel, { day: 4, start: "15:00", end: "16:00" });
  const music = await course("מוסיקה", omer, hostel, { day: 1, start: "10:00", end: "11:30" });
  const yoga = await course("יוגה", avia, community, { day: 2, start: "17:00", end: "18:00" });
  const seat = async (c, p, daysAgo) => note("enrollments", await Enrollment.create({ world: WORLD, cycle: c._id, student: p._id, status: "active", slotId: c.schedule[0]._id, joinedAt: sinceAgo(daysAgo), registeredAt: sinceAgo(daysAgo + 2), createdBy: by }));
  const seated = { [String(design._id)]: residents.slice(0, 6), [String(music._id)]: residents.slice(0, 7), [String(yoga._id)]: members };
  for (const c of [design, music, yoga]) for (const [i, p] of seated[String(c._id)].entries()) await seat(c, p, 60 - i * 3);

  // the last six weeks of lessons, attendance by the coordinator's report
  for (const c of [design, music, yoga]) {
    const cohort = seated[String(c._id)];
    for (let back = 1; back <= 42; back++) {
      const d = new Date(now.getTime() - back * DAY);
      if (d.getDay() !== c.schedule[0].day) continue;
      const key = localDay(d);
      note("lessons", await Lesson.create({ world: WORLD, cycle: c._id, date: utc(key), source: "live", attendance: cohort.map((p) => ({ student: p._id, status: rnd() < 0.8 ? "Present" : rnd() < 0.5 ? "AnnouncedAbsence" : "Missing" })) }));
    }
  }

  /* 6 ── last month's invoice round: אביה finished, עומר opened and stopped */
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
  const round = await rounds.openRound({ world: WORLD, month, program: "hostels", by });
  note("invoiceRounds", round);
  const reqAvia = await InvoiceRequest.findOne({ round: round._id, teacher: avia._id });
  const reqOmer = await InvoiceRequest.findOne({ round: round._id, teacher: omer._id });
  for (const r of [reqAvia, reqOmer]) note("invoiceRequests", r);
  await rounds.markSent({ world: WORLD, roundId: round._id, requestId: reqAvia._id, by });
  await rounds.markSent({ world: WORLD, roundId: round._id, requestId: reqOmer._id, by });
  await rounds.noteOpened(reqAvia);
  // her invoice covers every session but the second (a holiday)
  const covered = reqAvia.sessions.filter((s, i) => i !== 1).map((s) => String(s._id));
  await rounds.addInvoice(reqAvia, { imageData: dataUrl("image/png", makePng({ tint: [78, 59, 120], rows: 10, label: 1 })), imageName: "חשבונית-אביה.png", sessionIds: covered });
  await rounds.complete(reqAvia, { note: "המפגש השני לא התקיים בגלל חג. השאר התקיימו כרגיל." });
  await rounds.noteOpened(reqOmer);
  for (const inv of await Invoice.find({ request: reqAvia._id })) note("invoices", inv);

  /* 6b ── last month's attendance drafts from the houses (phase 3): דני marked, שמרית approved one */
  const opened = await reports.openMonth({ world: WORLD, month, by });
  for (const v of opened) note("hostelReports", v);
  const houseReport = await HostelReport.findById(opened.find((v) => String(v.hostel._id) === String(hostel._id))._id);
  const communityReport = await HostelReport.findById(opened.find((v) => String(v.hostel._id) === String(community._id))._id);
  await reports.markSent({ world: WORLD, reportId: houseReport._id, by });
  await reports.markSent({ world: WORLD, reportId: communityReport._id, by });
  await reports.noteOpened(houseReport);
  const designSessions = houseReport.sessions.filter((s) => String(s.cycle) === String(design._id));
  const musicSessions = houseReport.sessions.filter((s) => String(s.cycle) === String(music._id));
  const cohortDesign = seated[String(design._id)];
  const cohortMusic = seated[String(music._id)];
  const mark = (cohort, absent) => cohort.map((p, i) => (absent[i] ? { person: String(p._id), status: "absent", reason: absent[i], note: absent[i] === "hospital" ? "בהדסה עין כרם" : undefined } : { person: String(p._id), status: "present" }));
  if (designSessions[0]) await reports.setSession(houseReport, designSessions[0]._id, { state: "held", marks: mark(cohortDesign, [null, "hospital", null, null, "refused", null]) });
  if (designSessions[1]) await reports.setSession(houseReport, designSessions[1]._id, { state: "notHeld" });
  if (designSessions[2]) await reports.setSession(houseReport, designSessions[2]._id, { state: "held", marks: mark(cohortDesign, [null, null, null, "vacation", null, null]) });
  if (musicSessions[0]) await reports.setSession(houseReport, musicSessions[0]._id, { state: "held", marks: mark(cohortMusic, [null, null, "er", null, null, null, "unexplained"]) });
  if (musicSessions[1]) await reports.setSession(houseReport, musicSessions[1]._id, { state: "held", marks: mark(cohortMusic, [null, null, null, null, null, null, null]) });
  await reports.addExtra(houseReport, { name: "נועם טסט", cycle: String(design._id), note: "הגיע לראשונה, גר בבית מתחילת החודש" });
  await reports.addLeft(houseReport, { person: String(residents[5]._id), date: `${month}-20`, note: "עברה לדיור עצמאי" });
  await reports.complete(houseReport, { note: "המפגש השני של עיצוב לא התקיים - חג. בשבוע האחרון היו שני דיירים באשפוז." });
  if (designSessions[0]) await reports.approveSession({ world: WORLD, reportId: houseReport._id, sessionId: designSessions[0]._id, by });

  /* 7 ── papers: a syllabus for אביה, a certificate for עומר */
  const syllabus = makePdf(["Syllabus - Graphic Design - Hostel Test", "Teacher: Avia Test  |  Year: 2026-2027  |  Thursdays 15:00-16:00", "", "1. Shapes, colour and composition", "2. Letters: a poster with one word", "3. The computer: a first layout", "4. A card for the holidays", "5. Photos and collage", "6. The year's exhibition", "", "Test data - not a real document."]);
  const doc1 = await documents.add({ world: WORLD, personId: avia._id, kind: "syllabus", label: "סילבוס תשפ״ז", fileName: "syllabus-avia.pdf", mime: "application/pdf", data: syllabus, by });
  const cert = makePng({ width: 640, height: 480, tint: [42, 143, 132], rows: 5, label: 2 });
  const doc2 = await documents.add({ world: WORLD, personId: omer._id, kind: "other", label: "תעודת הוראה", fileName: "teaching-certificate.png", mime: "image/png", data: cert, thumb: dataUrl("image/png", makePng({ width: 320, height: 240, tint: [42, 143, 132], rows: 3, label: 2 })), by });
  for (const d of [doc1, doc2]) {
    note("personDocuments", d);
    ids.files.push(String(d.file));
  }
  ids.files.push(String((await Invoice.findOne({ request: reqAvia._id })).file));

  /* 8 ── אביה's supplier file, linked to her, the form filled */
  const supplier = await suppliers.create({ world: WORLD, body: { firstName: "אביה", lastName: "טסט", gender: "female", phone: "052-5551001", days: 14, person: String(avia._id) }, by });
  await suppliers.noteOpened(supplier);
  await suppliers.submitForm(supplier, {
    companyName: "אביה טסט - עיצוב והוראה",
    businessId: "123456789",
    address: { city: "ירושלים", street: "הדוגמה", number: "5", zip: "9100000" },
    contactName: "אביה טסט",
    contactPhone: "052-5551001",
    contactEmail: "avia.test@example.org",
    accountOwners: "אביה טסט",
    bank: { code: 12, name: "בנק הפועלים" },
    branch: { code: 600, name: "ירושלים" },
    accountNumber: "123456",
  });
  await suppliers.uploadFile(supplier, { key: "books", fileName: "ishur-nihul-sfarim.png", mime: "image/png", data: makePng({ width: 600, height: 800, tint: [168, 106, 8], rows: 7, label: 3 }), thumb: dataUrl("image/png", makePng({ width: 240, height: 320, tint: [168, 106, 8], rows: 3, label: 3 })) });
  note("suppliers", supplier);

  /* 9 ── the diaries: שמרית's, and Eden's */
  const accounts = await StaffAccount.find({ kind: { $in: ["hostels", "super"] }, active: true }).lean();
  const d = (days) => localDay(new Date(now.getTime() + days * DAY));
  for (const a of accounts) {
    const owner = String(a._id);
    const rows = [
      { date: d(-6), kind: "task", title: "לבקש מאביה את הסילבוס המעודכן", body: "אחרי פגישת המורים", done: true, doneAt: new Date(now - 5 * DAY) },
      { date: d(-3), kind: "task", title: "לשלוח לעומר תזכורת על החשבונית", body: "פתח את הקישור ולא סיים" },
      { date: d(-1), kind: "task", title: "להתקשר ליונית על רשימת הדיירים", body: "שני דיירים חדשים בהוסטל טסט" },
      { date: today, kind: "task", title: "לסגור את חודש החשבוניות", body: "כשכולם יסיימו - המייל להנהלת חשבונות" },
      { date: today, kind: "note", title: "ביקור בהוסטל טסט ב-16:00" },
      { date: d(4), kind: "note", title: "עומר טס לחו״ל", body: "חוזר בעוד שבועיים - אין שיעור מוסיקה" },
      { date: d(9), kind: "task", title: "לפתוח את חודש החשבוניות הבא" },
    ];
    for (const r of rows) note("diaryEntries", await DiaryEntry.create({ ...r, world: WORLD, owner, createdBy: a.name }));
  }

  writeLedger();
  console.log(
    [
      `Planted in "${WORLD}":`,
      `  2 houses (הוסטל טסט, קהילת טסט ב) · 3 teachers · ${residents.length + 1 + members.length} students · 3 courses · ${ids.lessons.length} lessons`,
      `  invoice round ${month}: אביה done (${reqAvia.sessions.length} sessions, 1 invoice), עומר opened`,
      `  hostel drafts ${month}: הוסטל טסט done (${houseReport.sessions.filter((s) => s.state).length} sessions marked, 1 approved, 1 newcomer, 1 leaver), קהילת טסט ב sent`,
      `  papers: אביה's syllabus (PDF), עומר's certificate (PNG) · אביה's supplier file (form + 1 certificate)`,
      `  diaries: ${accounts.map((a) => a.name).join(", ")} (7 lines each)`,
      `  ledger: ${LEDGER}`,
    ].join("\n")
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
