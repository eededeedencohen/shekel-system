/**
 * @file Enrollment service — the ONLY write path for cycle membership
 * @module services/enrollmentService
 *
 * Everything that touches seats goes through here, so the invariants hold
 * from every caller:
 *  - world isolation: the request's world must equal the cycle's world
 *    (WORLD_MISMATCH), and the enrollment's world is stamped from the
 *    cycle — never from the client.
 *  - capacity: active+reserved < capacity, checked inside a transaction
 *    (Atlas replica set — real transactions; the unique {cycle,student}
 *    index still backstops double-enrollment even without one).
 *  - slotId must exist on the cycle's schedule (SLOT_NOT_FOUND).
 *  - reservation fulfillment = status flip on the SAME document.
 *  - the two automatic moves of Eden's pipeline (2026-09-17) live here,
 *    because both are seat facts (see utils/domain PIPELINE_STAGES):
 *      · a seat RESERVED for a lead (Interested / Matching) parks them at
 *        "Intake" — the managers found a cycle, ייטב runs the intake; when
 *        the intake is already complete the seat sends them straight to
 *        "AwaitingPlacement" (a start date is all that is missing);
 *      · a seat turned ACTIVE with a start date for someone waiting after
 *        the intake (AwaitingPlacement / NeedsReplacement) makes them
 *        "Placed". A reserved seat for a NeedsReplacement student puts
 *        them at AwaitingPlacement (the date is still missing).
 *    A seat for a student AT Intake changes nothing — the intake file
 *    decides. And the way back: marking the ONLY seat of a Placed student
 *    "left" sends the college profile to "NeedsReplacement" (the board
 *    forbids dragging a placed card — leaving is a course fact).
 *    moveToStage() does the writing; the client only refreshes.
 */

const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const { Person } = require("../models/Person");
const { studentProfilesOf } = require("./profileService");
const AppError = require("../utils/AppError");
const { withTxn } = require("../utils/withTxn");
const { OCCUPYING_STATUSES } = require("../utils/domain");

/** Post-intake stages: an ACTIVE seat (the start date is set) is the placement. */
const AFTER_INTAKE = ["AwaitingPlacement", "NeedsReplacement"];
/** Pre-intake stages: a seat parks the student with the social worker. */
const BEFORE_INTAKE = ["Interested", "Matching"];

const HE_DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const fmtDay = (d) => {
  const x = new Date(d);
  return `יום ${HE_DAYS[x.getDay()]} ${x.getDate()}.${x.getMonth() + 1}.${x.getFullYear()}`;
};

/** "ציור" — the cycle's subject name for stage notes. */
async function cycleName(cycleId) {
  const c = await Cycle.findById(cycleId).populate({ path: "subject", select: "name" });
  return c?.subject?.name || "מחזור";
}

/**
 * Placement auto-advance — on the student's COLLEGE profile (cycles are a
 * מכללה לכל thing; a culture pipeline is never touched by a cycle seat).
 * `enrollment` is the record just written (its status says reserved/active).
 */
async function advancePlacement(personId, movedBy, enrollment) {
  const profiles = await studentProfilesOf(personId);
  const college = profiles.find((p) => p.kind === "StudentCollege");
  if (!college) return;
  const stage = college.pipeline?.stage;
  const active = enrollment.status === "active";
  if (BEFORE_INTAKE.includes(stage)) {
    const name = await cycleName(enrollment.cycle);
    // Lazy require: intakeService depends on enrollment records, not on us.
    const { isIntakeComplete } = require("./intakeService");
    if (await isIntakeComplete(personId, college.world)) {
      if (active) await college.moveToStage("Placed", movedBy, `שובץ/ה ל"${name}"`);
      else await college.moveToStage("AwaitingPlacement", movedBy, `שוריין מקום ב"${name}" — הקליטה כבר הושלמה, נשאר לקבוע תאריך התחלה`);
    } else {
      await college.moveToStage("Intake", movedBy, `שוריין מקום ב"${name}" — בקליטה אצל העו"ס`);
    }
  } else if (AFTER_INTAKE.includes(stage)) {
    const name = await cycleName(enrollment.cycle);
    if (active) {
      const when = enrollment.joinedAt ? ` · מתחיל/ה ב${fmtDay(enrollment.joinedAt)}` : "";
      await college.moveToStage("Placed", movedBy, `שובץ/ה ל"${name}"${when}`);
    } else if (stage === "NeedsReplacement") {
      await college.moveToStage("AwaitingPlacement", movedBy, `שוריין מקום ב"${name}" — נשאר לקבוע תאריך התחלה`);
    }
  }
}

/**
 * Leaving a course — the college profile of a PLACED student who holds no
 * other seat goes back to the search column as "דרוש שיבוץ מחדש" (the
 * board's rule, 2026-09-17: a placed card never moves by drag; leaving is
 * recorded on the course, and THAT sends the card back).
 */
async function dropPlacement(personId, movedBy, enrollment) {
  const profiles = await studentProfilesOf(personId);
  const college = profiles.find((p) => p.kind === "StudentCollege");
  if (!college || college.pipeline?.stage !== "Placed") return;
  const others = await Enrollment.countDocuments({ student: personId, status: { $in: OCCUPYING_STATUSES } });
  if (others > 0) return;
  const name = await cycleName(enrollment.cycle);
  await college.moveToStage("NeedsReplacement", movedBy, `ירד/ה מ"${name}" — דרוש שיבוץ מחדש`);
}

/** Occupied seats (active + reserved) for a cycle. */
async function occupiedCount(cycleId, session) {
  return Enrollment.countDocuments(
    { cycle: cycleId, status: { $in: OCCUPYING_STATUSES } },
    session ? { session } : undefined
  );
}

async function assertCycleAndStudent({ cycleId, studentId, world }) {
  const cycle = await Cycle.findById(cycleId);
  if (!cycle) throw AppError.of("NOT_FOUND", 404, "מחזור");
  if (cycle.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  const person = await Person.findById(studentId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "סטודנט");
  // A cycle seat is a מכללה לכל membership — the person must hold an ACTIVE
  // college profile (a culture-only student first transfers/joins).
  const studentProfiles = await studentProfilesOf(studentId);
  if (!studentProfiles.some((p) => p.kind === "StudentCollege")) {
    throw AppError.of("NO_STUDENT_PROFILE", 404, "מכללה לכל");
  }
  if (person.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  return { cycle, person };
}

function assertSlot(cycle, slotId) {
  if (!slotId) return;
  const ok = (cycle.schedule || []).some((s) => String(s._id) === String(slotId));
  if (!ok) throw AppError.of("SLOT_NOT_FOUND", 400);
}

/**
 * Enroll (status "active") or reserve (status "reserved") a student.
 * Fulfils an existing reservation / reactivates a left|completed record by
 * flipping the same document.
 */
async function enroll({ cycleId, studentId, world, status = "active", slotId = null, note, createdBy, joinedAt }) {
  if (!["active", "reserved"].includes(status)) throw AppError.of("INVALID_STATUS", 400);
  const { cycle, person } = await assertCycleAndStudent({ cycleId, studentId, world });
  assertSlot(cycle, slotId);

  const enrollment = await withTxn(async (session) => {
    const opts = session ? { session } : {};
    const existing = await Enrollment.findOne({ cycle: cycleId, student: studentId }).session(session || null);

    if (existing && OCCUPYING_STATUSES.includes(existing.status)) {
      if (status === "active" && existing.status === "reserved") {
        // fulfill the reservation — seat already counted, no capacity check
        existing.status = "active";
        existing.joinedAt = joinedAt || new Date();
        if (slotId !== null) existing.slotId = slotId;
        if (note !== undefined) existing.note = note;
        return existing.save(opts);
      }
      throw AppError.of("DUPLICATE_ENROLLMENT", 409);
    }

    // (re)taking a seat — enforce capacity inside the transaction
    const capacity = cycle.matching?.capacity;
    if (capacity != null) {
      const taken = await occupiedCount(cycleId, session);
      if (taken >= capacity) throw AppError.of("CYCLE_FULL", 409);
    }

    if (existing) {
      // left/completed → back in
      existing.status = status;
      existing.slotId = slotId;
      existing.leftAt = null;
      if (status === "active") existing.joinedAt = joinedAt || new Date();
      else existing.reservedAt = new Date();
      if (note !== undefined) existing.note = note;
      if (createdBy) existing.createdBy = createdBy;
      return existing.save(opts);
    }
    const created = await Enrollment.create(
      [
        {
          cycle: cycleId,
          student: studentId,
          world: cycle.world,
          status,
          slotId,
          note,
          createdBy,
          ...(status === "active"
            ? { joinedAt: joinedAt || new Date() }
            : { reservedAt: new Date() }),
        },
      ],
      opts
    );
    return created[0];
  });

  // A held seat counts too — it is what parks a lead with the social worker.
  await advancePlacement(studentId, createdBy, enrollment);
  return enrollment;
}

/**
 * Transition an existing enrollment: activate a reservation (with the
 * START DATE the managers entered — `joinedAt`), mark left / completed, or
 * re-reserve. Capacity re-checked when a non-occupying record re-takes a
 * seat.
 */
async function updateStatus({ enrollmentId, world, status, leftAt, joinedAt, note, movedBy }) {
  const enrollment = await Enrollment.findById(enrollmentId);
  if (!enrollment) throw AppError.of("NOT_FOUND", 404, "שיבוץ");
  if (enrollment.world !== world) throw AppError.of("WORLD_MISMATCH", 400);

  if (status === "active" || status === "reserved") {
    if (!OCCUPYING_STATUSES.includes(enrollment.status)) {
      const cycle = await Cycle.findById(enrollment.cycle);
      const capacity = cycle?.matching?.capacity;
      if (capacity != null && (await occupiedCount(enrollment.cycle)) >= capacity) {
        throw AppError.of("CYCLE_FULL", 409);
      }
    }
    if (status === "active") {
      if (joinedAt !== undefined && joinedAt !== null) {
        const start = new Date(joinedAt);
        if (isNaN(start.getTime())) throw AppError.of("INVALID_DATE", 400);
        enrollment.joinedAt = start;
      } else {
        enrollment.joinedAt = enrollment.joinedAt || new Date();
      }
      enrollment.leftAt = null;
    } else enrollment.reservedAt = new Date();
  } else if (status === "left") {
    enrollment.leftAt = leftAt || new Date();
  } else if (status === "completed") {
    // graduation — leftAt stays null unless explicitly given
    if (leftAt) enrollment.leftAt = leftAt;
  } else if (status !== undefined) {
    throw AppError.of("INVALID_STATUS", 400);
  }

  if (status !== undefined) enrollment.status = status;
  if (note !== undefined) enrollment.note = note;
  const saved = await enrollment.save();

  if (OCCUPYING_STATUSES.includes(status)) {
    await advancePlacement(enrollment.student, movedBy, saved);
  } else if (status === "left") {
    await dropPlacement(enrollment.student, movedBy, saved);
  }
  return saved;
}

module.exports = { enroll, updateStatus, occupiedCount };
