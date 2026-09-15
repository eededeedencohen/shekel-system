/**
 * @file cultureSeed — the תרבות לכל layer of a demo world
 * @module scripts/lib/cultureSeed
 *
 * Shared by seedTestData.js and seedPokemon.js so both worlds get the same
 * SHAPES with their own flavour (names, places, events). Everything goes
 * through the real services — programService.transfer for the moves,
 * cultureService.register/reportAttendance for the seats — so the demo
 * history is exactly what the app would have produced, invariants
 * included (unique registrations, capacity → waitlist, promotion, actor
 * rules). `trusted` only lifts the "published + future" gate so PAST
 * events can be built.
 *
 * What it builds (counts are options):
 *   · culture STAFF (ManagerCulture) — the only legal actors
 *   · culture-only students (new people) — pipeline at mixed stages
 *   · BOTH-programs students — existing college students who also join
 *     culture (rare)
 *   · TRANSFERS college → culture and one culture → college (rarer), dated
 *     in the past, with cycle seats given back / future registrations
 *     cancelled + waitlist promoted, and the story on both profiles
 *   · events: past (done, attendance reported), upcoming (some full, with
 *     waitlists), drafts, one cancelled
 *   · vouchers: in stock, granted, redeemed
 *
 * Deterministic: takes the caller's PRNG.
 */

const { Person } = require("../../models/Person");
const { Profile } = require("../../models/profiles");
const Event = require("../../models/Event");
const EventRegistration = require("../../models/EventRegistration");
const Voucher = require("../../models/Voucher");
const { createPersonWithProfile, createProfile } = require("../../services/profileService");
const program = require("../../services/programService");
const culture = require("../../services/cultureService");

const DAY = 86400000;

/**
 * @param {object} o
 * @param {string}   o.world
 * @param {Function} o.rnd               PRNG in [0,1)
 * @param {Array}    o.collegeStudents   [{ person, stage, enrolled? }] of the world
 * @param {object}   o.flavour           names/places/events (see seeds)
 * @param {object}   [o.counts]          how many of each shape
 * @param {Function} [o.availabilityFn]  () → availability[] for new people
 * @param {Array}    [o.guestPool]       people WITHOUT a culture profile who may
 *                                       be brought along as אורח/ת (family at
 *                                       "ערב הורים וילדים" — senzey's guest type)
 */
async function seedCulture({ world, rnd, collegeStudents, flavour, counts = {}, availabilityFn, guestPool = [] }) {
  const now = Date.now();
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const daysAgo = (d) => new Date(now - d * DAY);
  const daysAhead = (d) => new Date(now + d * DAY);
  const at = (date, hour) => {
    const d = new Date(date);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  const C = {
    cultureOnlyNew: 22,
    both: 3,
    transfersToCulture: 2,
    transfersToCollege: 1,
    pastEvents: 8,
    upcomingEvents: 6,
    drafts: 2,
    vouchers: 14,
    ...counts,
  };
  const F = flavour;
  const out = { staff: [], students: [], events: [], vouchers: [], transfers: [] };

  /* ── 1 · staff ────────────────────────────────────────────── */
  for (const [i, s] of F.staff.entries()) {
    const { person } = await createPersonWithProfile(
      "ManagerCulture",
      {
        world,
        firstName: s.firstName,
        lastName: s.lastName ?? F.lastName,
        email: `${F.emailPrefix}_culture_staff_${i}@${F.emailDomain}`,
        phone: `050-${String(4000000 + i * 12345).slice(0, 7)}`,
        title: s.title,
      },
      { trusted: true, opened: { by: F.systemActor, note: "צוות תרבות לכל" } }
    );
    out.staff.push(person);
  }
  const staffOf = (i) => out.staff[i % out.staff.length];

  /* ── 2 · culture-only students (new humans) ───────────────── */
  const STAGES = ["Interested", "Interested", "Intake", "Intake", "Placed", "Placed", "Placed", "Placed"];
  const PATHS = {
    Interested: ["Interested"],
    Intake: ["Interested", "Intake"],
    Placed: ["Interested", "Intake", "Placed"],
  };
  let sn = 0;
  const names = shuffle(F.studentFirstNames || []);
  for (let i = 0; i < C.cultureOnlyNew; i++) {
    const stage = STAGES[i % STAGES.length];
    const p = PATHS[stage];
    const firstMoveAgo = ri(15, 120);
    const step = Math.max(3, Math.floor(firstMoveAgo / p.length));
    const stageHistory = p.map((st, idx) => ({
      stage: st,
      movedBy: staffOf(i).firstName,
      movedAt: daysAgo(firstMoveAgo - idx * step),
      note: idx === 0 ? "נרשם/ה דרך אתר תרבות לכל" : "",
    }));
    const tail = stageHistory[stageHistory.length - 1];
    const age = ri(19, 64);
    const { person } = await createPersonWithProfile(
      "StudentCulture",
      {
        world,
        firstName: names[sn % names.length] || `סטודנט${sn}`,
        lastName: F.lastName,
        email: `${F.emailPrefix}_culture_${sn}@${F.emailDomain}`,
        phone: `058-${String(2000000 + sn * 733).slice(0, 7)}`,
        birthDate: daysAgo(Math.round(age * 365.25 + ri(0, 300))),
        gender: sn % 3 === 0 ? "male" : "female",
        availability: availabilityFn ? availabilityFn() : [],
        pipeline: { stage: tail.stage, since: tail.movedAt },
        stageHistory,
        since: stageHistory[0].movedAt,
        log: [{ event: "opened", at: stageHistory[0].movedAt, by: staffOf(i).firstName, note: "קליטה לתרבות לכל" }],
        interests: [],
        emergencyContact: pick(["אמא", "אבא", "אח", "מדריכת דיור"]),
        emergencyPhone: `052-${String(3000000 + sn * 311).slice(0, 7)}`,
        notes: F.studentNote,
      },
      { trusted: true }
    );
    out.students.push({ person, stage, origin: "culture" });
    sn++;
  }

  /* ── 3 · BOTH programs: existing college students who also join ── */
  const pool = shuffle(collegeStudents.filter((s) => s.stage === "Placed"));
  const bothPicks = pool.slice(0, C.both);
  for (const [i, s] of bothPicks.entries()) {
    const person = await Person.findById(s.person._id);
    const openedAt = daysAgo(ri(20, 90));
    await createProfile(
      person,
      "StudentCulture",
      {
        emergencyContact: "כמו במכללה",
        since: openedAt,
        log: [{ event: "opened", at: openedAt, by: staffOf(i).firstName, note: "ממשיך/ה במכללה ונרשם/ת גם לאירועי תרבות" }],
        stageHistory: [
          { stage: "Interested", movedBy: staffOf(i).firstName, movedAt: openedAt, note: "הצטרפות לתרבות לכל בנוסף למכללה" },
          { stage: "Placed", movedBy: staffOf(i).firstName, movedAt: new Date(openedAt.getTime() + 5 * DAY), note: "" },
        ],
        pipeline: { stage: "Placed", since: new Date(openedAt.getTime() + 5 * DAY) },
      },
      { trusted: true }
    );
    out.students.push({ person, stage: "Placed", origin: "both" });
  }

  /* ── 4 · TRANSFERS college → culture (the rare move) ─────────── */
  const rest = pool.slice(C.both);
  const withSeats = rest.filter((s) => (s.enrolled?.length || 0) > 0);
  const movers = (withSeats.length >= C.transfersToCulture ? withSeats : rest).slice(0, C.transfersToCulture);
  for (const [i, s] of movers.entries()) {
    const when = daysAgo(ri(12, 45));
    const { effects } = await program.transfer({
      personId: s.person._id,
      world,
      from: "StudentCollege",
      to: "StudentCulture",
      by: staffOf(i).firstName,
      note: pick(F.transferNotes.toCulture),
      at: when,
      stage: "Placed",
    });
    const person = await Person.findById(s.person._id);
    out.students.push({ person, stage: "Placed", origin: "transferred" });
    out.transfers.push({ person, from: "StudentCollege", to: "StudentCulture", at: when, effects });
  }

  const cultureStudents = () => out.students.map((s) => s.person);

  /* ── 5 · events ───────────────────────────────────────────── */
  const templates = shuffle(F.events);
  let tI = 0;
  const nextTemplate = () => templates[tI++ % templates.length];

  const mkEvent = async ({ dayOffset, status, i }) => {
    const t = nextTemplate();
    const staff = staffOf(i);
    const date = at(dayOffset < 0 ? daysAgo(-dayOffset) : daysAhead(dayOffset), t.hour || 18);
    const createdAt = new Date(date.getTime() - ri(14, 40) * DAY);
    const ev = await Event.create({
      world,
      name: t.name,
      date,
      endTime: t.endTime,
      category: t.category,
      location: t.location,
      description: t.description,
      price: t.price || 0,
      ...(t.guests && { notes: [t.notes, "פתוח לאורחים"].filter(Boolean).join(" · ") }),
      settings: {
        gender: t.gender || "all",
        capacity: t.capacity,
        ...(t.ageMin != null && { ageMin: t.ageMin }),
        ...(t.ageMax != null && { ageMax: t.ageMax }),
      },
      status,
      created: { by: staff._id, at: createdAt },
      published: status === "draft" ? null : { by: staff._id, at: new Date(createdAt.getTime() + 2 * DAY) },
      ...(status === "cancelled" && { cancelledAt: new Date(date.getTime() - 3 * DAY) }),
      ...(!t.guests && t.notes && { notes: t.notes }),
    });
    ev.$template = t;
    out.events.push(ev);
    return ev;
  };

  /** Fill an event: registered up to `fill` of capacity (+ waitlist). */
  const fillEvent = async (ev, { fillRatio, waitlist = 0, cancelSome = false, past = false, i }) => {
    const cap = ev.settings.capacity || 10;
    const eligible = shuffle(cultureStudents()).filter((p) => !culture.eligibilityIssues(ev, p).length);
    const seats = Math.min(eligible.length, Math.round(cap * fillRatio));
    const wanted = Math.min(eligible.length, seats + waitlist);
    const regs = [];
    const base = new Date(ev.published?.at || ev.created.at);
    for (let k = 0; k < wanted; k++) {
      const student = eligible[k];
      const self = rnd() < 0.5;
      const when = new Date(base.getTime() + (k + 1) * ri(6, 30) * 3600000);
      const r = await culture.register({
        eventId: ev._id,
        studentId: student._id,
        world,
        by: self ? student._id : staffOf(i + k)._id,
        reason: self ? "נרשם/ה באתר" : "נרשם/ה דרך הרכז/ת",
        at: when > ev.date ? new Date(ev.date.getTime() - DAY) : when,
        trusted: true,
      });
      regs.push({ r, student });
    }
    // Guests (senzey "אורח/ת"): family/friends brought by staff to open events.
    if (ev.$template?.guests && guestPool.length) {
      const seatsLeft = Math.max(0, cap - regs.filter((x) => x.r.status === "registered").length);
      for (const g of shuffle(guestPool).slice(0, Math.min(seatsLeft, ri(1, 2)))) {
        if (culture.eligibilityIssues(ev, g).length) continue;
        try {
          await culture.register({
            eventId: ev._id, studentId: g._id, world, by: staffOf(i)._id, guest: true,
            reason: pick(F.guestReasons || ["אורח/ת"]), at: new Date(base.getTime() + ri(24, 72) * 3600000), trusted: true,
          });
        } catch (e) {
          if (e.code !== "DUPLICATE_REGISTRATION") throw e;
        }
      }
    }
    // A couple of cancellations with reasons (promotes the waitlist head).
    if (cancelSome && regs.length > 2) {
      for (const { r, student } of regs.filter((x) => x.r.status === "registered").slice(0, ri(1, 2))) {
        await culture.cancelRegistration({
          registrationId: r._id,
          world,
          by: rnd() < 0.5 ? student._id : staffOf(i)._id,
          reason: pick(F.cancelReasons),
          at: new Date(ev.date.getTime() - ri(1, 6) * DAY),
        });
      }
    }
    if (past) {
      const live = await EventRegistration.find({ event: ev._id, status: "registered" });
      for (const r of live) {
        const present = rnd() < 0.82;
        await culture.reportAttendance({
          registrationId: r._id,
          world,
          by: staffOf(i)._id,
          present,
          note: present ? (rnd() < 0.2 ? pick(F.attendanceNotes.present) : undefined) : pick(F.attendanceNotes.absent),
          at: new Date(ev.date.getTime() + 3 * 3600000),
          trusted: true,
        });
      }
    }
  };

  // past — done, attendance reported
  for (let i = 0; i < C.pastEvents; i++) {
    const ev = await mkEvent({ dayOffset: -ri(4, 95), status: "done", i });
    await fillEvent(ev, { fillRatio: pick([0.6, 0.8, 1, 1]), waitlist: rnd() < 0.4 ? ri(1, 2) : 0, cancelSome: rnd() < 0.6, past: true, i });
  }
  // upcoming — published; two of them full with a waitlist
  for (let i = 0; i < C.upcomingEvents; i++) {
    const ev = await mkEvent({ dayOffset: ri(2, 60), status: "published", i });
    const full = i < 2;
    await fillEvent(ev, { fillRatio: full ? 1 : pick([0.3, 0.5, 0.7]), waitlist: full ? ri(2, 3) : 0, cancelSome: !full && rnd() < 0.3, i });
  }
  // drafts — nobody registered yet
  for (let i = 0; i < C.drafts; i++) await mkEvent({ dayOffset: ri(20, 75), status: "draft", i });
  // one cancelled future event with its seats cancelled
  {
    const ev = await mkEvent({ dayOffset: ri(5, 30), status: "published", i: 0 });
    await fillEvent(ev, { fillRatio: 0.5, i: 0 });
    await culture.cancelEvent({ eventId: ev._id, world, by: staffOf(0)._id, reason: pick(F.eventCancelReasons), at: daysAgo(ri(1, 4)) });
  }

  /* ── 6 · one TRANSFER culture → college (rarer still) ────────── */
  for (let i = 0; i < C.transfersToCollege; i++) {
    const candidate = out.students.find((s) => s.origin === "culture" && s.stage === "Placed" && !s.moved);
    if (!candidate) break;
    // register them to a future event first so the transfer has something
    // to give back (visible as a cancelled registration with the reason).
    // Re-read from the DB: the in-memory docs predate cancelEvent().
    const upcoming = await Event.findOne({
      world, status: "published", date: { $gt: new Date(now) }, "settings.capacity": { $gt: 4 },
    }).sort({ date: 1 });
    if (upcoming) {
      try {
        await culture.register({ eventId: upcoming._id, studentId: candidate.person._id, world, by: candidate.person._id, at: daysAgo(10), trusted: true });
      } catch (e) {
        if (e.code !== "DUPLICATE_REGISTRATION") throw e;
      }
    }
    const when = daysAgo(ri(3, 9));
    const { effects } = await program.transfer({
      personId: candidate.person._id,
      world,
      from: "StudentCulture",
      to: "StudentCollege",
      by: staffOf(i).firstName,
      note: pick(F.transferNotes.toCollege),
      at: when,
      stage: "Matching",
    });
    candidate.moved = true;
    out.transfers.push({ person: candidate.person, from: "StudentCulture", to: "StudentCollege", at: when, effects });
  }

  /* ── 7 · vouchers ─────────────────────────────────────────── */
  const holders = shuffle(cultureStudents().filter((p) => !out.students.find((s) => s.moved && String(s.person._id) === String(p._id))));
  for (let i = 0; i < C.vouchers; i++) {
    const place = F.voucherPlaces[i % F.voucherPlaces.length];
    const value = pick([50, 80, 100, 150, 200]);
    const v = await Voucher.create({
      world,
      name: place.name,
      number: `${place.prefix}-${String(1000 + i * 37)}`,
      initialValue: value,
      balance: value,
      expiresAt: daysAhead(ri(30, 365)),
      notes: place.note,
    });
    // ~60% granted, of those ~half redeemed
    if (rnd() < 0.6 && holders.length) {
      const student = holders[i % holders.length];
      const grantedAt = daysAgo(ri(2, 60));
      await culture.grantVoucher({ voucherId: v._id, world, by: staffOf(i)._id, studentId: student._id, at: grantedAt, note: pick(F.voucherNotes) });
      if (rnd() < 0.5) {
        await culture.redeemVoucher({ voucherId: v._id, world, by: staffOf(i)._id, at: new Date(grantedAt.getTime() + ri(1, 20) * DAY) });
        await Voucher.updateOne({ _id: v._id }, { $set: { balance: 0 } });
      }
    }
    out.vouchers.push(v);
  }

  /* ── summary ─────────────────────────────────────────────── */
  const regCount = await EventRegistration.countDocuments({ world });
  const waitCount = await EventRegistration.countDocuments({ world, status: "waitlisted" });
  const granted = await Voucher.countDocuments({ world, grant: { $ne: null } });
  const activeCulture = await Profile.countDocuments({ world, kind: "StudentCulture", active: true });
  const both = await Profile.aggregate([
    { $match: { world, active: true, kind: { $in: ["StudentCollege", "StudentCulture"] } } },
    { $group: { _id: "$person", n: { $sum: 1 } } },
    { $match: { n: 2 } },
    { $count: "n" },
  ]);
  console.log(
    `\n🎭 תרבות לכל (${world}): ${out.staff.length} אנשי צוות · ${activeCulture} סטודנטים פעילים ` +
      `(${both[0]?.n || 0} בשתי התוכניות, ${out.transfers.length} מעברים) · ` +
      `${out.events.length} אירועים · ${regCount} רישומים (${waitCount} ברשימת המתנה) · ` +
      `${out.vouchers.length} שוברים (${granted} חולקו)`
  );
  for (const t of out.transfers) {
    console.log(
      `   ↔ ${t.person.firstName} ${t.person.lastName}: ${t.from === "StudentCollege" ? "מכללה → תרבות" : "תרבות → מכללה"} ` +
        `(${t.at.toISOString().slice(0, 10)}) — ` +
        Object.entries(t.effects).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ")
    );
  }
  return out;
}

module.exports = { seedCulture };
