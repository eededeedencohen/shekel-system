/**
 * @file intakeSeed — demo cases for the social worker's board (קליטה)
 * @module scripts/lib/intakeSeed
 *
 * Builds, through the REAL services (intakeService.submitLanding / schedule /
 * markDone / documents, enrollmentService.enroll / updateStatus), a small
 * set of people in every state of Eden's 2026-09-17 pipeline, so the test
 * world's boards are populated the moment they open:
 *
 *   ממתינים לשיחה ראשונית — culture leads from the landing page (one with a
 *                     parent filling the form, one with a document already
 *                     uploaded), a college lead the managers reserved a seat
 *                     for (→ Intake, no call yet), one person who chose BOTH
 *   בהמתנה לאינטייק — an overdue meeting, one today, one in three days
 *   בוצע אינטייק · משלימים תיק — the meeting was held; the approval and/or
 *                     documents are missing (one rejected upload)
 *   נקלטו לאחרונה   — complete files: a culture member (Placed), a college
 *                     student whose held seat waits for a START DATE
 *                     (AwaitingPlacement — the managers' step), and one
 *                     whose start date is set for next week (Placed)
 *   + a walk-in the staff opened without the landing page, and ייטב
 *     herself as a SocialWorker profile.
 *
 * Every timestamp is then shifted back so "days waiting" reads naturally.
 * Deterministic (no PRNG needed); fake people carry the world's lastName.
 */

const fs = require("fs");
const path = require("path");
const Intake = require("../../models/Intake");
const Enrollment = require("../../models/Enrollment");
const { Profile } = require("../../models/profiles");
const { createPersonWithProfile } = require("../../services/profileService");
const intake = require("../../services/intakeService");
const { enroll, updateStatus } = require("../../services/enrollmentService");

const DAY = 86400000;

/** A 1×1 PNG and a one-page PDF — enough for a browser to open. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]/Contents 4 0 R>>endobj\n" +
    "4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 40 70 Td (Shekel demo) Tj ET\nendstream\nendobj\n" +
    "xref\n0 5\n0000000000 65535 f \ntrailer<</Root 1 0 R/Size 5>>\n%%EOF\n"
);

/** Shift every timestamp of a case back by `days` (a uniform slide). */
async function backdate(personId, days) {
  const shift = (d) => (d ? new Date(new Date(d).getTime() - days * DAY) : d);
  for (const p of await Profile.find({ person: personId })) {
    for (const h of p.stageHistory || []) h.movedAt = shift(h.movedAt);
    if (p.pipeline?.since) p.pipeline.since = shift(p.pipeline.since);
    for (const l of p.log || []) l.at = shift(l.at);
    if (p.since) p.since = shift(p.since);
    p.markModified("stageHistory");
    p.markModified("pipeline");
    p.markModified("log");
    await p.save();
  }
  for (const e of await Enrollment.find({ student: personId })) {
    // reservedAt/joinedAt slide with everything else — except a start date
    // in the future (the "מתחיל/ה ב…" demo), which must stay ahead of today.
    if (e.reservedAt) e.reservedAt = shift(e.reservedAt);
    if (e.joinedAt && e.joinedAt.getTime() < Date.now()) e.joinedAt = shift(e.joinedAt);
    await e.save();
  }
  const i = await Intake.findOne({ person: personId });
  if (i) {
    if (i.landing?.submittedAt) i.landing.submittedAt = shift(i.landing.submittedAt);
    if (i.scheduled?.setAt) i.scheduled.setAt = shift(i.scheduled.setAt);
    if (i.done?.at) {
      i.done.at = shift(i.done.at);
      i.done.waiverSignedAt = shift(i.done.waiverSignedAt);
    }
    if (i.completedAt) i.completedAt = shift(i.completedAt);
    for (const l of i.log || []) l.at = shift(l.at);
    for (const d of i.documents || []) {
      if (d.file?.uploadedAt) d.file.uploadedAt = shift(d.file.uploadedAt);
      if (d.receivedAt) d.receivedAt = shift(d.receivedAt);
    }
    i.markModified("documents");
    i.markModified("log");
    await i.save();
  }
}

const at = (daysFromNow, hour, minute = 0) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};

/**
 * @param {object} o
 * @param {string}   o.world
 * @param {string}   o.lastName   the world's fake surname ("טסט")
 * @param {Function} o.findSeat   () → cycle id with a free seat, or null
 * @param {string[]} [o.subjectIds] a few subject ids for college preferences
 * @param {Function} [o.log]
 */
async function seedIntakes({ world, lastName, findSeat, subjectIds = [], log = () => {} }) {
  const out = { people: [], byState: {} };
  const BY = "ייטב";
  let phoneN = 0;
  const phone = () => `054-77${String(10000 + phoneN++ * 37).slice(0, 5)}`;

  /* ── ייטב as a person with the SocialWorker role ── */
  const yetav = await createPersonWithProfile(
    "SocialWorker",
    { world, firstName: "ייטב", lastName, email: `${world}_social_worker@${world}.local`, phone: "050-4433221", title: 'עו"ס קליטה' },
    { trusted: true, opened: { by: "מערכת", note: "עובדת סוציאלית — קליטה" } }
  );
  out.socialWorker = yetav.person;

  const landing = (body) => intake.submitLanding({ world, body: { lastName, phone: phone(), ...body } });
  /**
   * Hold a seat for a college lead. The caller's findSeat() works from its
   * own counts — a seat taken meanwhile by someone else (the app is live
   * while the seed runs) answers CYCLE_FULL, so try the next one.
   */
  const holdSeat = async (studentId, by) => {
    for (let i = 0; i < 25; i++) {
      const seat = findSeat();
      if (!seat) return null;
      try {
        await enroll({ cycleId: seat, studentId, world, status: "reserved", createdBy: by, note: "מקום שמור — תאריך התחלה ייקבע בסיום הקליטה" });
        return seat;
      } catch (e) {
        if (e.code !== "CYCLE_FULL") throw e;
      }
    }
    return null;
  };
  const upload = async (rec, key, file, name) =>
    intake.uploadDocument({ intake: rec, key, fileName: name, mime: file === PDF ? "application/pdf" : "image/png", data: file, staff: false });
  // An approval (אישור שקדייה) is received with its "valid until" date — a year ahead here.
  const tick = (rec, key, status, note) =>
    intake.setDocumentStatus({ intake: rec, key, status, by: BY, note, ...(key === "shkedia" && status === "received" && { validUntil: at(365, 0) }) });
  const record = (personId) => Intake.findOne({ world, person: personId });
  const remember = (state, person) => {
    out.people.push({ state, person });
    out.byState[state] = (out.byState[state] || 0) + 1;
  };

  /* ── 1 · ממתינים לשיחה ראשונית ── */
  {
    const r = await landing({
      firstName: "ליאור", gender: "male", birthDate: new Date("1998-04-12"),
      programs: ["StudentCulture"],
      filledBy: { role: "self" },
      residenceLabel: "דירה עצמאית בקהילה", city: "ירושלים",
      preferences: { categories: ["standup", "movie", "outing"], notes: "אוהב סטנדאפ, מעדיף ערבים" },
    });
    await upload(await record(r.person._id), "psychiatric", PDF, "psychiatric-report.pdf");
    await backdate(r.person._id, 2);
    remember("queue", r.person);
  }
  {
    const r = await landing({
      firstName: "מיכל", gender: "female", birthDate: new Date("2001-09-30"),
      programs: ["StudentCulture"],
      filledBy: { role: "family", name: "רונית (אמא)", phone: "052-6677889" },
      residenceLabel: "בבית עם המשפחה", city: "מבשרת ציון",
      emergencyContact: "רונית", emergencyPhone: "052-6677889",
      preferences: { categories: ["theatre", "musical", "restaurant", "trip"], notes: "צריכה הסעה מהבית, לא נוסעת לבד" },
    });
    await backdate(r.person._id, 5);
    remember("queue", r.person);
  }
  {
    const r = await landing({
      firstName: "יונתן", gender: "male", birthDate: new Date("1996-01-20"),
      programs: ["StudentCollege"],
      filledBy: { role: "coordinator", name: "אורית — מתאמת שיקום", phone: "02-5551234" },
      residenceLabel: "הוסטל ליבא",
      preferences: { subjects: subjectIds.slice(0, 2), days: [0, 2], dayParts: ["morning"] },
    });
    await holdSeat(r.person._id, "נעה");
    await backdate(r.person._id, 9);
    remember("queue", r.person);
  }
  {
    const r = await landing({
      firstName: "נועה", gender: "female", birthDate: new Date("1993-07-07"),
      programs: ["StudentCulture", "StudentCollege"],
      filledBy: { role: "self" },
      residenceLabel: "דיור מוגן", city: "ירושלים",
      preferences: { subjects: subjectIds.slice(1, 3), categories: ["concert", "party", "festival"], days: [1, 3], dayParts: ["afternoon", "evening"] },
    });
    const rec = await record(r.person._id);
    await upload(rec, "psychiatric", PDF, "psychiatric.pdf");
    await upload(rec, "psychosocial", PDF, "psychosocial.pdf");
    await upload(rec, "socialClub", PNG, "moadon.png");
    await backdate(r.person._id, 1);
    remember("queue", r.person);
  }

  /* ── 2 · בהמתנה לאינטייק ── */
  {
    const r = await landing({
      firstName: "עמית", gender: "male", birthDate: new Date("1999-11-11"),
      programs: ["StudentCulture"], filledBy: { role: "self" },
      preferences: { categories: ["sportEvent", "sport", "outing"] },
    });
    await intake.schedule({ intake: await record(r.person._id), at: at(-2, 11), by: BY, note: "במשרד ביד חרוצים" });
    await backdate(r.person._id, 8);
    remember("scheduled", r.person);
  }
  {
    const r = await landing({
      firstName: "שירה", gender: "female", birthDate: new Date("1997-03-03"),
      programs: ["StudentCollege"], filledBy: { role: "family", name: "דוד (אבא)" },
      residenceLabel: "בבית עם המשפחה",
      preferences: { subjects: subjectIds.slice(2, 4), days: [0, 1, 2], dayParts: ["morning"] },
    });
    await holdSeat(r.person._id, "חגי");
    await intake.schedule({ intake: await record(r.person._id), at: at(0, 11), by: BY, note: "מגיעה עם אבא" });
    await backdate(r.person._id, 6);
    remember("scheduled", r.person);
  }
  {
    const r = await landing({
      firstName: "דניאל", gender: "male", birthDate: new Date("1990-12-25"),
      programs: ["StudentCulture"], filledBy: { role: "self" },
      preferences: { categories: ["museum", "lecture", "trip"] },
    });
    const rec = await record(r.person._id);
    await upload(rec, "psychiatric", PDF, "psychiatric.pdf");
    await upload(rec, "waiver", PDF, "vitur-sodiyut.pdf");
    await intake.schedule({ intake: rec, at: at(3, 10), by: BY });
    await backdate(r.person._id, 4);
    remember("scheduled", r.person);
  }

  /* ── 3 · בוצע אינטייק · משלימים תיק ── */
  {
    const r = await landing({
      firstName: "רותם", gender: "female", birthDate: new Date("1995-05-15"),
      programs: ["StudentCulture"], filledBy: { role: "self" },
      preferences: { categories: ["workshop", "community", "volunteering"] },
    });
    const rec = await record(r.person._id);
    await upload(rec, "socialClub", PNG, "moadon.png");
    await intake.schedule({ intake: rec, at: at(-5, 12), by: BY });
    await intake.markDone({ intake: rec, at: at(-4, 12), by: BY, waiverSigned: true, summary: "שיחה נעימה, מתאימה לסדנאות ולערבי קהילה. חסרים הדוחות ואישור שקדייה — תביא בשבוע הבא." });
    await tick(rec, "socialClub", "received");
    await backdate(r.person._id, 12);
    remember("documents", r.person);
  }
  {
    const r = await landing({
      firstName: "אלון", gender: "male", birthDate: new Date("2000-02-02"),
      programs: ["StudentCollege"], filledBy: { role: "coordinator", name: "מיכאל — הוסטל עתיד" },
      residenceLabel: "הוסטל עתיד",
      preferences: { subjects: subjectIds.slice(0, 1), days: [3, 4], dayParts: ["afternoon"] },
    });
    await holdSeat(r.person._id, "נעה");
    const rec = await record(r.person._id);
    await upload(rec, "psychiatric", PNG, "psychiatric-blurry.png");
    await upload(rec, "psychosocial", PDF, "psychosocial.pdf");
    await upload(rec, "socialClub", PDF, "moadon.pdf");
    await intake.schedule({ intake: rec, at: at(-2, 9, 30), by: BY });
    await intake.markDone({ intake: rec, at: at(-1, 9, 30), by: BY, waiverSigned: true, summary: "מתאים לקבוצה קטנה. הדוח הפסיכיאטרי לא קריא — ביקשתי לצלם שוב." });
    await tick(rec, "psychiatric", "rejected", "הצילום לא קריא — נא לצלם שוב באור טוב");
    await tick(rec, "psychosocial", "received");
    await tick(rec, "socialClub", "received");
    await tick(rec, "shkedia", "received");
    await backdate(r.person._id, 10);
    remember("documents", r.person);
  }

  /* ── 4 · נקלטו לאחרונה ── */
  {
    const r = await landing({
      firstName: "הילה", gender: "female", birthDate: new Date("1994-08-08"),
      programs: ["StudentCulture"], filledBy: { role: "self" },
      preferences: { categories: ["theatre", "movie", "restaurant"] },
    });
    const rec = await record(r.person._id);
    for (const [k, f, n] of [["psychiatric", PDF, "psychiatric.pdf"], ["psychosocial", PDF, "psychosocial.pdf"], ["socialClub", PNG, "moadon.png"], ["waiver", PDF, "vitur.pdf"]]) {
      await upload(rec, k, f, n);
    }
    await tick(rec, "shkedia", "received");
    await intake.schedule({ intake: rec, at: at(-7, 10), by: BY });
    await intake.markDone({ intake: rec, at: at(-6, 10), by: BY, summary: "הכל בתיק — משובצת לתרבות לכל." });
    await backdate(r.person._id, 16);
    remember("done", r.person);
  }
  {
    // מכללה לכל: the file is complete, the seat is held — waiting for נעה/חגי to enter the start date
    const r = await landing({
      firstName: "עידו", gender: "male", birthDate: new Date("1992-06-16"),
      programs: ["StudentCollege"], filledBy: { role: "self" },
      residenceLabel: "דירה עצמאית בקהילה",
      preferences: { subjects: subjectIds.slice(3, 5), days: [0, 2, 4] },
    });
    await holdSeat(r.person._id, "חגי");
    const rec = await record(r.person._id);
    await intake.schedule({ intake: rec, at: at(-12, 10), by: BY });
    await intake.markDone({ intake: rec, at: at(-11, 10), by: BY, waiverSigned: true, summary: "הביא את כל המסמכים לפגישה." });
    for (const k of ["psychiatric", "psychosocial", "socialClub", "shkedia"]) await tick(rec, k, "received");
    await backdate(r.person._id, 20);
    remember("done", r.person);
  }
  {
    // מכללה לכל: the start date is set for next week — משובץ/ת, "מתחיל/ה ב…"
    const r = await landing({
      firstName: "תמר", gender: "female", birthDate: new Date("1997-09-09"),
      programs: ["StudentCollege"], filledBy: { role: "coordinator", name: "נטע — דיור מוגן" },
      residenceLabel: "דיור מוגן",
      preferences: { subjects: subjectIds.slice(1, 2), days: [1, 3], dayParts: ["morning"] },
    });
    const seat = await holdSeat(r.person._id, "נעה");
    const rec = await record(r.person._id);
    await intake.schedule({ intake: rec, at: at(-16, 10), by: BY });
    await intake.markDone({ intake: rec, at: at(-15, 10), by: BY, waiverSigned: true, summary: "מתאימה מאוד לקבוצה; הביאה את כל המסמכים." });
    for (const k of ["psychiatric", "psychosocial", "socialClub", "shkedia"]) await tick(rec, k, "received");
    if (seat) {
      const held = await Enrollment.findOne({ world, student: r.person._id, cycle: seat, status: "reserved" });
      if (held) {
        await updateStatus({ enrollmentId: held._id, world, status: "active", joinedAt: at(7, 0), movedBy: "נעה", note: "עודכנו המסגרת והסטודנטית" });
      }
    }
    await backdate(r.person._id, 24);
    remember("done", r.person);
  }

  /* ── 5 · a walk-in: the staff opened the record, no landing page ── */
  {
    const { person } = await createPersonWithProfile(
      "StudentCulture",
      { world, firstName: "גל", lastName, phone: phone(), gender: "other", birthDate: new Date("1989-10-10"), notes: "הגיע/ה דרך חבר/ה שכבר משתתף/ת" },
      { trusted: true, pipelineInit: { stage: "Interested", movedBy: "שירן", note: "פנה/תה טלפונית" }, opened: { by: "שירן", note: "הצטרפות דרך חבר/ה" } }
    );
    const rec = await intake.ensureIntake({ person, world, source: "staff", by: BY });
    await intake.schedule({ intake: rec, at: at(1, 13), by: BY, note: "בטלפון — קשה להגיע למשרד" });
    await backdate(person._id, 3);
    remember("scheduled", person);
  }

  log(
    `Intake demo: ${out.people.length} cases — ` +
      Object.entries(out.byState).map(([k, v]) => `${k} ${v}`).join(" · ") +
      ` · social worker ${yetav.person.firstName}`
  );
  return out;
}

/** Remove the world's uploaded files (purge helper for the seeds). */
function purgeUploads(world) {
  const dir = path.join(intake.uploadRoot(), world);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { seedIntakes, purgeUploads };
