/**
 * @file Test data factories — 2026 remodel shapes
 * @module tests/helpers/factories
 *
 * Each factory returns a saved document. Pass `overrides` to customise:
 *
 *   const t = await makeTeacher();
 *   const cycle = await makeCycle({ teacher: t._id, matching: { capacity: 2 } });
 */

const { createPersonWithProfile } = require("../../services/profileService");
const Subject = require("../../models/Subject");
const Cycle = require("../../models/Cycle");
const Enrollment = require("../../models/Enrollment");
const Room = require("../../models/Room");
const Hostel = require("../../models/Hostel");
const Lesson = require("../../models/Lesson");
const Event = require("../../models/Event");
const Voucher = require("../../models/Voucher");
const Book = require("../../models/Book");

let counter = 0;
const unique = () => `${Date.now()}_${counter++}`;

/**
 * Person + a StudentCollege profile. Returns the PERSON document (the id
 * every ref uses) with the profile attached as `person.profile`.
 */
const makeStudent = async (overrides = {}) => {
  const { person, profile } = await createPersonWithProfile(
    "StudentCollege",
    {
      firstName: "סטודנט",
      lastName: `בדיקה_${counter}`,
      email: `student_${unique()}@test.local`,
      ...overrides,
    },
    { trusted: true }
  );
  person.profile = profile;
  // convenience delegation — the pipeline lives on the profile now
  person.moveToStage = (...args) => profile.moveToStage(...args);
  return person;
};

/** Person + a Teacher profile — same contract as makeStudent. */
const makeTeacher = async (overrides = {}) => {
  const { person, profile } = await createPersonWithProfile(
    "Teacher",
    {
      firstName: "מורה",
      lastName: `בדיקה_${counter}`,
      email: `teacher_${unique()}@test.local`,
      ...overrides,
    },
    { trusted: true }
  );
  person.profile = profile;
  return person;
};

const makeSubject = (overrides = {}) =>
  Subject.create({
    name: `מקצוע_${unique()}`,
    category: "music",
    ...overrides,
  });

const makeRoom = (overrides = {}) =>
  Room.create({
    name: `חדר_${unique()}`,
    ...overrides,
  });

const makeHostel = (overrides = {}) =>
  Hostel.create({
    name: `הוסטל_${unique()}`,
    ...overrides,
  });

/** Cycle + its Subject (and nothing else) unless provided. */
const makeCycle = async (overrides = {}) => {
  const subject = overrides.subject || (await makeSubject())._id;
  return Cycle.create({
    subject,
    startDate: new Date("2026-03-01"),
    endDate: new Date("2026-06-30"),
    schedule: [{ day: 2, start: "10:00", end: "11:30" }],
    ...overrides,
  });
};

/** Direct Enrollment record (bypassing the service) for read-path tests. */
const makeEnrollment = async (overrides = {}) => {
  const cycle = overrides.cycle || (await makeCycle())._id;
  const student = overrides.student || (await makeStudent())._id;
  return Enrollment.create({
    cycle,
    student,
    world: "real",
    status: "active",
    joinedAt: new Date("2026-03-02"),
    ...overrides,
  });
};

/** Lesson + its Cycle unless provided. */
const makeLesson = async (overrides = {}) => {
  const cycle = overrides.cycle || (await makeCycle())._id;
  return Lesson.create({
    cycle,
    date: new Date("2026-03-15T00:00:00.000Z"),
    ...overrides,
  });
};

/* ───────────────────────── תרבות לכל ───────────────────────── */

/** Person + an ACTIVE ManagerCulture profile (the only legal event actor). */
const makeCultureStaff = async (overrides = {}) => {
  const { person, profile } = await createPersonWithProfile(
    "ManagerCulture",
    {
      firstName: "רותם",
      lastName: `צוות_${counter}`,
      email: `culture_staff_${unique()}@test.local`,
      title: "רכזת תרבות",
      ...overrides,
    },
    { trusted: true }
  );
  person.profile = profile;
  return person;
};

/** Person + a StudentCulture profile (pipeline at Interested). */
const makeCultureStudent = async (overrides = {}) => {
  const { person, profile } = await createPersonWithProfile(
    "StudentCulture",
    {
      firstName: "סטודנט",
      lastName: `תרבות_${counter}`,
      email: `culture_student_${unique()}@test.local`,
      gender: "female",
      birthDate: new Date("1995-05-05"),
      ...overrides,
    },
    { trusted: true, pipelineInit: { stage: "Interested", movedBy: "בדיקה" } }
  );
  person.profile = profile;
  return person;
};

/** A PUBLISHED future event (+ its staff creator unless given). */
const makeEvent = async (overrides = {}) => {
  const by = overrides.by || (await makeCultureStaff())._id;
  const { by: _by, ...rest } = overrides;
  const at = new Date();
  return Event.create({
    name: `אירוע_${unique()}`,
    date: new Date(Date.now() + 7 * 86400000),
    category: "theatre",
    status: "published",
    created: { by, at },
    published: { by, at },
    settings: { gender: "all", capacity: 10 },
    ...rest,
  });
};

const makeVoucher = (overrides = {}) =>
  Voucher.create({
    name: "סינמה סיטי",
    number: `V-${unique()}`,
    balance: 100,
    initialValue: 100,
    ...overrides,
  });

/* ───────────────────────── הספרייה ───────────────────────── */

/** A shelf book (no loan) — barcode unique per call. */
const makeBook = (overrides = {}) =>
  Book.create({
    barcode: String(36200000000 + (counter++)),
    title: `ספר_${unique()}`,
    author: "סופר/ת בדיקה",
    source: "manual",
    ...overrides,
  });

module.exports = {
  makeBook,
  makeStudent,
  makeTeacher,
  makeSubject,
  makeRoom,
  makeHostel,
  makeCycle,
  makeEnrollment,
  makeLesson,
  makeCultureStaff,
  makeCultureStudent,
  makeEvent,
  makeVoucher,
};
