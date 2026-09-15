/**
 * @file Program service — a student's memberships in מכללה לכל / תרבות לכל
 *       over time, and the ONLY writer of a profile's lifecycle log
 * @module services/programService
 *
 * The business facts (Eden, Sept 2026):
 *  - a student can be in BOTH programs at once — rare, but real → two
 *    profiles on one person, nothing special.
 *  - a student can MOVE from one program to the other — very rare, and
 *    everything must stay documented on the student → `transfer()` closes
 *    the source profile (transferredOut) and opens/reopens the target
 *    (transferredIn) in one story, and unwinds the live memberships of the
 *    program being left (cycle seats → "left", future event registrations
 *    → cancelled + waitlist promotion) with a reason on every record.
 *
 * Nothing here deletes anything: a closed profile keeps its pipeline,
 * history, enrollments and registrations — they just become past tense.
 */

const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");
const Enrollment = require("../models/Enrollment");
const EventRegistration = require("../models/EventRegistration");
require("../models/Event"); // registers the model the populate below needs
const AppError = require("../utils/AppError");
const { STUDENT_KINDS, PROGRAM_LABELS, OCCUPYING_STATUSES } = require("../utils/domain");

/** The stage a (re)opened student profile starts at unless told otherwise. */
const DEFAULT_ENTRY_STAGE = "Interested";

/**
 * Unwind the live memberships of the program a student is leaving.
 * Returns counts so callers (and the UI) can say what happened.
 */
async function leaveProgramEffects({ personId, kind, at, reason }) {
  const effects = { enrollmentsLeft: 0, registrationsCancelled: 0, promoted: 0 };

  if (kind === "StudentCollege") {
    const live = await Enrollment.find({ student: personId, status: { $in: OCCUPYING_STATUSES } });
    for (const e of live) {
      e.status = "left";
      // leftAt may never precede joinedAt (schema rule) — a back-dated
      // transfer closes the seat on the day it was taken at the earliest.
      e.leftAt = e.joinedAt && e.joinedAt > at ? e.joinedAt : at;
      e.note = [e.note, reason].filter(Boolean).join(" · ");
      await e.save();
      effects.enrollmentsLeft++;
    }
  }

  if (kind === "StudentCulture") {
    // Lazy require: cultureService depends on nothing here, but keep the
    // graph one-directional at load time anyway.
    const { promoteNext } = require("./cultureService");
    const live = await EventRegistration.find({
      student: personId,
      status: { $in: ["registered", "waitlisted"] },
    }).populate({ path: "event", select: "date status" });
    for (const r of live) {
      // Past events are history — only future seats are given back.
      if (r.event?.date && r.event.date.getTime() < at.getTime()) continue;
      const wasRegistered = r.status === "registered";
      r.status = "cancelled";
      r.cancelledAt = at;
      r.waitlist = undefined;
      r.history.push({ action: "cancelled", at, reason });
      await r.save();
      effects.registrationsCancelled++;
      if (wasRegistered && (await promoteNext(r.event._id, at))) effects.promoted++;
    }
  }
  return effects;
}

/** Person + world/deleted guards shared by every entry point. */
async function requirePerson(personId, world) {
  const person = await Person.findById(personId);
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  if (person.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  return person;
}

/**
 * Move a student from one program to the other.
 *   { personId, world, from, to, by, note, at?, stage? }
 * Returns { source, target, effects }.
 */
async function transfer({ personId, world, from, to, by, note, at, stage }) {
  if (!STUDENT_KINDS.includes(from) || !STUDENT_KINDS.includes(to) || from === to) {
    throw AppError.of("INVALID_TRANSFER", 400, `${from} → ${to}`);
  }
  const when = at ? new Date(at) : new Date();
  const person = await requirePerson(personId, world);

  const source = await Profile.findOne({ person: person._id, kind: from });
  if (!source || !source.active) throw AppError.of("PROFILE_INACTIVE", 400, PROGRAM_LABELS[from]);
  let target = await Profile.findOne({ person: person._id, kind: to });
  if (target && target.active) {
    throw AppError.of("INVALID_TRANSFER", 400, `כבר פעיל/ה ב${PROGRAM_LABELS[to]} — סגרו את ${PROGRAM_LABELS[from]} במקום`);
  }

  // 1 · close the source side of the story
  source.active = false;
  source.until = when;
  source.log.push({ event: "transferredOut", at: when, by, note, otherKind: to });
  await source.save();

  // 2 · give back what the old program was holding for them
  const effects = await leaveProgramEffects({
    personId: person._id,
    kind: from,
    at: when,
    reason: `עבר/ה ל${PROGRAM_LABELS[to]}`,
  });

  // 3 · open (or reopen) the target side
  const entryStage = stage || DEFAULT_ENTRY_STAGE;
  if (target) {
    target.active = true;
    target.since = when;
    target.until = null;
    target.log.push({ event: "transferredIn", at: when, by, note, otherKind: from });
    await target.save();
    await target.moveToStage(entryStage, by, `הועבר/ה מ${PROGRAM_LABELS[from]}`);
  } else {
    const Model = MODEL_BY_KIND[to];
    target = new Model({
      person: person._id,
      world: person.world,
      active: true,
      since: when,
      log: [{ event: "transferredIn", at: when, by, note, otherKind: from }],
      stageHistory: [{ stage: entryStage, movedBy: by, movedAt: when, note: `הועבר/ה מ${PROGRAM_LABELS[from]}` }],
      pipeline: { stage: entryStage, since: when },
    });
    await target.save();
  }

  return { source, target, effects };
}

/**
 * Close a profile (leave a program / retire a role) with a reason.
 * Student kinds unwind their live memberships; other kinds just close.
 */
async function closeProfile({ profile, world, by, note, at }) {
  if (profile.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (!profile.active) throw AppError.of("PROFILE_INACTIVE", 400);
  const when = at ? new Date(at) : new Date();
  profile.active = false;
  profile.until = when;
  profile.log.push({ event: "closed", at: when, by, note });
  await profile.save();
  const effects = STUDENT_KINDS.includes(profile.kind)
    ? await leaveProgramEffects({ personId: profile.person, kind: profile.kind, at: when, reason: note || "עזב/ה את התוכנית" })
    : null;
  return { profile, effects };
}

/** Reopen a closed profile; a student profile restarts its pipeline. */
async function reopenProfile({ profile, world, by, note, at, stage }) {
  if (profile.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (profile.active) throw AppError.of("PROFILE_ACTIVE", 400);
  const person = await requirePerson(profile.person, world);
  const when = at ? new Date(at) : new Date();
  profile.active = true;
  profile.since = when;
  profile.until = null;
  profile.log.push({ event: "reopened", at: when, by, note });
  await profile.save();
  if (STUDENT_KINDS.includes(profile.kind)) {
    await profile.moveToStage(stage || DEFAULT_ENTRY_STAGE, by, note || "חזר/ה לתוכנית");
  }
  return { profile, person };
}

/**
 * The person's program story, merged across ALL their student profiles
 * (active and closed), oldest first — what the student page renders.
 */
async function programTimeline(personId) {
  const profiles = await Profile.find({ person: personId, kind: { $in: STUDENT_KINDS } }).lean();
  const entries = [];
  for (const p of profiles) {
    for (const l of p.log || []) {
      entries.push({ kind: p.kind, program: PROGRAM_LABELS[p.kind], profile: p._id, ...l });
    }
  }
  // Both halves of a transfer share one timestamp — the leaving side reads
  // first, so a tie breaks on the event's natural order.
  const RANK = { opened: 0, closed: 1, transferredOut: 1, transferredIn: 2, reopened: 2 };
  entries.sort((a, b) => new Date(a.at) - new Date(b.at) || (RANK[a.event] ?? 9) - (RANK[b.event] ?? 9));
  return { profiles, entries };
}

module.exports = { transfer, closeProfile, reopenProfile, programTimeline, DEFAULT_ENTRY_STAGE };
