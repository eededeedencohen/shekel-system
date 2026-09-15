/**
 * @file Intake controller — a lead enters a department's pipeline
 * @module controllers/intakeController
 *
 * POST /api/people/intake — find-or-create the PERSON (by phone/email
 * within the world), then create the student profile for the requested
 * department at stage "Interested". This kills the old duplicate-person
 * bug: a lead who already exists (came back, or through another
 * department) gets a second PROFILE, never a second human.
 *
 * Body: { firstName*, lastName*, department? ("StudentCollege" default |
 *         "StudentCulture"), phone?, email?, birthDate?, gender?,
 *         residenceLabel?, notes?, movedBy? }
 */

const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { STUDENT_KINDS } = require("../utils/domain");
const { createProfile, profilesOf, flattenPerson } = require("../services/profileService");

exports.createIntakeLead = catchAsync(async (req, res, next) => {
  const { firstName, lastName, department, phone, email, birthDate, gender, residenceLabel, notes, movedBy } = req.body;
  if (!firstName || !lastName) return next(AppError.of("MISSING_FIELDS", 400, "שם פרטי ושם משפחה"));
  const kind = department || "StudentCollege";
  if (!STUDENT_KINDS.includes(kind)) return next(AppError.of("INVALID_KIND", 400, kind));

  // Find-or-create the human: phone/email are the practical intake keys.
  const or = [];
  if (email) or.push({ email: email.toLowerCase().trim() });
  if (phone) or.push({ phone: phone.trim() });
  let person = or.length
    ? await Person.findOne({ world: req.world, deletedAt: null, $or: or })
    : null;
  const personExisted = !!person;
  if (!person) {
    person = await Person.create({
      world: req.world,
      firstName,
      lastName,
      ...(phone && { phone }),
      ...(email && { email }),
      ...(birthDate && { birthDate }),
      ...(gender && { gender }),
    });
  }

  const profile = await createProfile(
    person,
    kind,
    {
      ...(notes && { notes }),
      ...(residenceLabel && kind === "StudentCollege" && { residence: { label: residenceLabel } }),
    },
    {
      pipelineInit: { stage: "Interested", movedBy, note: "נוצר כמתעניין" },
      opened: { by: movedBy, note: personExisted ? "הצטרפות לתוכנית נוספת" : "קליטה ראשונה" },
    }
  );

  const profiles = await profilesOf(person._id);
  res.status(201).json({
    status: "success",
    data: { person: flattenPerson(person, profiles), profile, personExisted },
  });
});
