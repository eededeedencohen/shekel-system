/**
 * @file Seed script — populates Users + Teacher/Student profiles
 * @module seed
 *
 * Sources:
 *   - Teachers: hardcoded from the "מכללה לכל" subset of the staff table.
 *   - Students: parsed from ../סטודנטים.xls (HTML table exported from Excel),
 *     filtered to rows whose status contains "מכללה לכל".
 *
 * Idempotent: runs upserts keyed on email (User) and user-id (profiles),
 * so re-running the script does not create duplicates.
 *
 * Usage:  node seed.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const connectDB = require("./config/db");
const User = require("./models/User");
const Student = require("./models/Student");
const Teacher = require("./models/Teacher");
const {
  splitName,
  parseDate,
  parseGender,
  cleanText,
} = require("./utils/parsers");

// ---------------------------------------------------------------------------
// Teacher list (from staff sheet — only rows whose role contains "מורה")
// ---------------------------------------------------------------------------
const TEACHERS = [
  { firstName: "אביה", lastName: "רוטשטיין", email: null, phone: null, birthDate: null, subject: "עיצוב גרפי" },
  { firstName: "נעמה", lastName: "פרינר נעמת", email: null, phone: "050-280-1019", birthDate: null, subject: "פיתוח קול | אמן יוצר" },
  { firstName: "חיים", lastName: "כהן", email: null, phone: "054-586-5009", birthDate: null, subject: "מוזיקה" },
  { firstName: "שעיה", lastName: "ראדאל", email: "shayagrodal@gmail.com", phone: "058-722-1633", birthDate: null, subject: "אנגלית" },
  { firstName: "אלה", lastName: "בקלינסקי", email: null, phone: "054-222-3109", birthDate: "02/06/1949", subject: "פסנתר" },
  { firstName: "חוסאם", lastName: "אבו דיאב", email: "husam.abudiab@gmail.com", phone: "054-594-3219", birthDate: "04/04/1991", subject: "צילום וקולנוע" },
  { firstName: "יואב", lastName: "סרוסי", email: null, phone: null, birthDate: null, subject: "מחשבים" },
  { firstName: "טליה", lastName: "פרי", email: "imrixi3@gmail.com", phone: "052-642-5220", birthDate: null, subject: "ציור" },
  { firstName: "אליה", lastName: "לונסקי", email: null, phone: "058-499-7415", birthDate: null, subject: "מוזיקה" },
  { firstName: "רחל", lastName: "פרידמן", email: "rachelfman@gmail.com", phone: "054-630-0432", birthDate: null, subject: "גרפיקה" },
  { firstName: "דן", lastName: "פינדלינג", email: "findlingz@gmail.com", phone: "054-586-5009", birthDate: "03/05/1993", subject: "מוזיקה" },
  { firstName: "אלישבע", lastName: "וולר", email: null, phone: "058-709-8605", birthDate: null, subject: "מוזיקה" },
  { firstName: "נעה", lastName: "שכטר", email: null, phone: null, birthDate: null, subject: "אומנות" },
  { firstName: "אמיר", lastName: "שוחט", email: "talf@shekel.org.il", phone: "052-864-8014", birthDate: null, subject: "מוזיקה" },
];

// ---------------------------------------------------------------------------
// HTML-table parsing for the student sheet
// ---------------------------------------------------------------------------

/**
 * Parse the exported-Excel HTML table into an array of row-cell arrays.
 * The file is regular enough that regex-based extraction is safe.
 * Cell text is run through `cleanText` to strip invisible control chars.
 */
function parseTable(html) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      cells.push(
        cleanText(c[1].replace(/&nbsp;/g, "").replace(/<[^>]+>/g, ""))
      );
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

async function upsertStudent({
  id,
  name,
  email,
  status,
  phone,
  birthDate,
  gender,
  address,
  city,
  notes,
  emergencyContact,
  emergencyPhone,
}) {
  const { firstName, lastName } = splitName(name);
  const finalEmail = (email && email.trim()) || `student_${id}@placeholder.local`;

  const user = await User.findOneAndUpdate(
    { email: finalEmail.toLowerCase() },
    {
      firstName,
      lastName,
      email: finalEmail,
      role: "Student",
      phone: phone && phone.trim() ? phone.trim() : "-",
      birthDate: parseDate(birthDate),
      gender: parseGender(gender),
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Student.findOneAndUpdate(
    { user: user._id },
    {
      user: user._id,
      type: [status],
      address: address || undefined,
      city: city || undefined,
      notes: notes || undefined,
      emergencyContact: emergencyContact || undefined,
      emergencyPhone:
        emergencyPhone && emergencyPhone.trim()
          ? emergencyPhone.trim()
          : "-",
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return user;
}

async function upsertTeacher({
  firstName,
  lastName,
  email,
  phone,
  birthDate,
  subject,
}) {
  // Placeholder email is ASCII-safe (stable hash of the name), since the User
  // schema validates email format and many teachers in the source have none.
  const hash = crypto
    .createHash("md5")
    .update(`${firstName}|${lastName}`)
    .digest("hex")
    .slice(0, 10);
  const finalEmail = (email || `teacher_${hash}@placeholder.local`).toLowerCase();

  const user = await User.findOneAndUpdate(
    { email: finalEmail },
    {
      firstName,
      lastName,
      email: finalEmail,
      role: "Teacher",
      phone: phone && phone.trim() ? phone.trim() : "-",
      birthDate: parseDate(birthDate),
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Teacher.findOneAndUpdate(
    { user: user._id },
    { user: user._id, subject: subject || undefined },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return user;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Remove role-profile documents (Teacher / Student) whose `user` ref no
 * longer points to an existing User. Prevents counts from drifting when
 * Users are wiped externally (e.g. via Compass) between seed runs.
 */
async function pruneOrphanProfiles() {
  let removed = 0;
  for (const Model of [Teacher, Student]) {
    const profiles = await Model.find({}, { user: 1 });
    for (const p of profiles) {
      const exists = await User.exists({ _id: p.user });
      if (!exists) {
        await Model.deleteOne({ _id: p._id });
        removed++;
      }
    }
  }
  if (removed) console.log(`🧹 Pruned ${removed} orphan profiles`);
}

(async () => {
  try {
    await connectDB();
    await pruneOrphanProfiles();

    // --- Teachers ---
    let teacherCount = 0;
    let teacherSkipped = 0;
    for (const t of TEACHERS) {
      try {
        await upsertTeacher(t);
        teacherCount++;
      } catch (err) {
        teacherSkipped++;
        console.warn(
          `  ⚠️  skipped teacher ${t.lastName} ${t.firstName}: ${err.message}`
        );
      }
    }
    console.log(`✅ Upserted ${teacherCount} teachers (skipped ${teacherSkipped})`);

    // --- Students ---
    const filePath = path.join(__dirname, "..", "סטודנטים מעודכן.xls");
    const html = fs.readFileSync(filePath, "utf8");
    const rows = parseTable(html);

    // Header row is first; skip it. Column layout: [id, name, status, tz, email, ...]
    const dataRows = rows.slice(1);
    const studentRows = dataRows.filter(
      (r) => r[2] && r[2].includes("מכללה לכל")
    );

    let studentCount = 0;
    let skipped = 0;
    for (const r of studentRows) {
      // Source column layout (0-indexed):
      //   0 id  1 name  2 status  3 tz  4 email  5 email2  6 phone  7 phone2
      //   8 address  9 city  10 region  11 gender  12 birthDate  13 age
      //   14 active  15 agent  16 marital  17 children  18 notes ...
      //   26 emergencyContact  27 emergencyPhone
      const [id, name, status, , email] = r;
      if (!name) {
        skipped++;
        continue;
      }
      try {
        await upsertStudent({
          id,
          name,
          email,
          status,
          phone: r[6],
          birthDate: r[12],
          gender: r[11],
          address: r[8],
          city: r[9],
          notes: r[18],
          emergencyContact: r[26],
          emergencyPhone: r[27],
        });
        studentCount++;
      } catch (err) {
        skipped++;
        console.warn(`  ⚠️  skipped ${id} (${name}): ${err.message}`);
      }
    }
    console.log(`✅ Upserted ${studentCount} students (skipped ${skipped})`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  }
})();
