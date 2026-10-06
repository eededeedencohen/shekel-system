/**
 * @file Tag migration — the old profiles → personTags / cycleTags
 * @module services/tagMigration
 *
 * Additive and idempotent: run it as often as you like, on any world. It
 * never touches profiles, people or cycles — the old code keeps working
 * while the new tables fill up.
 *
 * What a person gets:
 *  - the tags of every profile kind they ever held (KIND_TAGS), open when
 *    the profile is active, closed (until = profile.until) when not;
 *  - `hostels` when they hold a live seat (reserved | active) in a
 *    hostel's cycle, or live in a hostel (residence.hostel);
 *  - `college` ONLY when they are really in מכללה לכל: an active
 *    StudentCollege profile AND (a seat in a college cycle, ever, OR no
 *    hostel seat at all). A student whose seats are all in hostel cycles
 *    is a hostels student, not a college one (Eden, 2026-10-05).
 *  - the profile's lifecycle log, copied to the program tag's events.
 * What a cycle gets: `hostels` when it has a hostel, else `college`.
 */

const { Profile } = require("../models/Profile");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const { PersonTag, PersonTagEvent } = require("../models/PersonTag");
const CycleTag = require("../models/CycleTag");
const tags = require("./tagService");

const LIVE = ["reserved", "active"];

async function migrateWorld(world, { dry = false, log = () => {} } = {}) {
  const catalog = dry ? await tags.tagMap(world) : await tags.ensureCatalog(world);
  const tagId = (key) => catalog.get(key)._id;

  const [profiles, cycles, enrollments] = await Promise.all([
    Profile.find({ world }).lean(),
    Cycle.find({ world }).select("_id hostel").lean(),
    Enrollment.find({ world }).select("student cycle status joinedAt reservedAt").lean(),
  ]);
  const hostelCycles = new Set(cycles.filter((c) => c.hostel).map((c) => String(c._id)));
  const liveHostelSeat = new Set();
  const anyHostelSeat = new Set();
  const anyCollegeSeat = new Set();
  for (const e of enrollments) {
    const sid = String(e.student);
    if (hostelCycles.has(String(e.cycle))) {
      anyHostelSeat.add(sid);
      if (LIVE.includes(e.status)) liveHostelSeat.add(sid);
    } else anyCollegeSeat.add(sid);
  }

  // what every person should hold: key → { since, until }
  const wanted = new Map(); // personId → Map(key → { since, until, events })
  const want = (person, key, { since, until, events = [] }) => {
    const pid = String(person);
    if (!wanted.has(pid)) wanted.set(pid, new Map());
    const cur = wanted.get(pid).get(key);
    if (!cur) wanted.get(pid).set(key, { since, until, events });
    else {
      // held through two profiles (student via college + culture): open wins, earliest since
      cur.since = cur.since && since ? new Date(Math.min(cur.since, since)) : cur.since || since;
      cur.until = cur.until && until ? new Date(Math.max(cur.until, until)) : null;
      cur.events = cur.events.concat(events);
    }
  };

  let hostelOnly = 0;
  for (const p of profiles) {
    const pid = String(p.person);
    const active = p.active !== false;
    const since = p.since || p.createdAt || null;
    const until = active ? null : p.until || p.updatedAt || new Date();
    const programKey = tags.PROGRAM_OF_KIND[p.kind];
    for (const key of tags.KIND_TAGS[p.kind] || []) {
      if (key === "college" && active && liveHostelSeat.has(pid) && !anyCollegeSeat.has(pid)) {
        hostelOnly++;
        // a hostels student, not a college one — an open college row (written beside the profile) closes
        if (!dry) await tags.take({ world, personId: pid, key: "college", by: "מערכת", note: "לומד/ת רק בקורסים של הוסטל" });
        continue;
      }
      const events =
        key === programKey
          ? (p.log || []).map((l) => ({
              event: l.event,
              at: l.at || since || new Date(),
              by: l.by,
              note: l.note,
              otherTag: l.otherKind && tags.PROGRAM_OF_KIND[l.otherKind] ? tagId(tags.PROGRAM_OF_KIND[l.otherKind]) : null,
            }))
          : [];
      want(pid, key, { since, until, events });
    }
    if (p.kind === "StudentCollege" && p.residence && p.residence.hostel) want(pid, "hostels", { since, until: active ? null : until });
  }
  for (const pid of liveHostelSeat) {
    const seatSince = enrollments.filter((e) => String(e.student) === pid && hostelCycles.has(String(e.cycle))).map((e) => e.joinedAt || e.reservedAt).filter(Boolean);
    want(pid, "hostels", { since: seatSince.length ? new Date(Math.min(...seatSince.map((d) => new Date(d)))) : new Date(), until: null });
  }

  const stats = { people: wanted.size, rows: 0, inserted: 0, updated: 0, events: 0, cycles: cycles.length, cycleRows: 0, hostelOnly };
  for (const [pid, byKey] of wanted) {
    for (const [key, w] of byKey) {
      stats.rows++;
      const filter = { person: pid, tag: tagId(key) };
      const existing = await PersonTag.findOne(filter).lean();
      if (dry) {
        if (!existing) stats.inserted++;
        continue;
      }
      let row = existing;
      if (!existing) {
        row = await PersonTag.create({ world, person: pid, tag: tagId(key), since: w.since || new Date(), until: w.until });
        stats.inserted++;
      } else if (String(existing.until || "") !== String(w.until || "")) {
        await PersonTag.updateOne({ _id: existing._id }, { $set: { until: w.until } });
        stats.updated++;
      }
      const events = w.events.length ? w.events : [{ event: "opened", at: row.since || w.since || new Date(), by: "מערכת", note: "אתחול התגיות" }];
      for (const ev of events) {
        const had = await PersonTagEvent.exists({ personTag: row._id, event: ev.event, at: ev.at });
        if (had) continue;
        await PersonTagEvent.create({ world, personTag: row._id, ...ev });
        stats.events++;
      }
    }
  }

  for (const c of cycles) {
    stats.cycleRows++;
    if (!dry) await tags.setCycleProgram({ world, cycleId: c._id, key: c.hostel ? "hostels" : "college" });
  }
  // a cycle tag whose cycle is gone
  if (!dry) await CycleTag.deleteMany({ world, cycle: { $nin: cycles.map((c) => c._id) } });

  log(`[${world}] people ${stats.people} · tag rows ${stats.rows} (new ${stats.inserted}, changed ${stats.updated}) · events ${stats.events} · cycles ${stats.cycles} · hostel-only students kept out of college: ${stats.hostelOnly}${dry ? " (dry)" : ""}`);
  return stats;
}

module.exports = { migrateWorld };
