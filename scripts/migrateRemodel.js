/**
 * @file migrateRemodel — the 2026 DB remodel (8 → 7 collections)
 * @module scripts/migrateRemodel
 *
 * Rebuilds the app's data into the new model (see db-remodel-plan.html at
 * the repo root):
 *
 *   users+students+teachers → people      (same _id as User — refs survive)
 *   basecourses             → subjects    (same _id; category → English key)
 *   courses+courseinstances → cycles      (same _id as CourseInstance;
 *                                          Course layer dissolved into import.*)
 *   enrolledStudents rows   → enrollments (first-class; unique {cycle,student})
 *   lessons                 → lessons_v2  (renamed fields; source live|archive)
 *   room name strings       → rooms_v2    (the old rooms collection is EMPTY —
 *                                          every room today is a free string)
 *   domain.HOSTELS          → hostels     (managed entity)
 *
 * Everything is DERIVED from the untouched source collections, so --apply
 * is idempotent by construction (drop-and-rebuild of the NEW collections
 * only — sources are never written).
 *
 * IMPORTANT: the `users` collection is SHARED with other apps on this Atlas
 * DB (it holds foreign username/passwordHash docs). It is therefore never
 * renamed or written — the app simply stops reading it after cutover.
 *
 * Modes:
 *   node scripts/migrateRemodel.js --dry-run   reports only, writes nothing
 *   node scripts/migrateRemodel.js --apply     build the new collections
 *   node scripts/migrateRemodel.js --cutover   verify, then rename the old
 *                                              app-only collections to
 *                                              zz_legacy_* and promote
 *                                              lessons_v2/rooms_v2
 *
 * Optional manual overrides (survives re-runs): migration-map.json next to
 * this file — { "subjects": {"raw string": "subject name"}, "hostels": {...} }.
 * Reports land in scripts/migration-reports/.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const connectDB = require("../config/db");
const { HOSTELS, SUBJECT_CATEGORY_KEYS } = require("../utils/domain");

const MODE = process.argv.includes("--cutover")
  ? "cutover"
  : process.argv.includes("--apply")
  ? "apply"
  : "dry-run";

const REPORT_DIR = path.join(__dirname, "migration-reports");
fs.mkdirSync(REPORT_DIR, { recursive: true });
const reports = {};
function report(name, data) {
  reports[name] = data;
  const n = Array.isArray(data) ? data.length : typeof data === "object" ? Object.keys(data).length : data;
  console.log(`  📄 ${name}: ${n}`);
  fs.writeFileSync(path.join(REPORT_DIR, `${name}.json`), JSON.stringify(data, null, 1));
}

/** Legacy Hebrew category label → English SUBJECT_CATEGORIES key. */
const CATEGORY_MAP = {
  "מוזיקה": "music",
  "מוסיקה": "music",
  "אומנות": "art",
  "אמנות": "art",
  "תנועה ומחול": "movement",
  "מלאכה": "crafts",
  "בישול": "cooking",
  "מדיה ועיצוב": "media",
  "לימודים והעשרה": "enrichment",
  "כישורי חיים": "lifeSkills",
  "בעלי חיים": "animals",
  "אירועים": "events",
  "סוג פוקימון": "pokemon",
};

const APP_ROLES = ["Student", "Teacher", "Admin"];
const worldOf = (ds) => (ds === "pokemon" || ds === "test" ? ds : "real");
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
/** Subject-name normalization: מוסיקה/מוזיקה drift + role/venue prefixes. */
const subjNorm = (s) =>
  norm(s)
    .replace(/^מורה ל/, "")
    .replace(/^מנהיג\/ת מכון ה/, "")
    .replace(/^מכון ה/, "")
    .replace(/^חוג\s+/, "")
    .replace(/מוסיקה/g, "מוזיקה");
/** UTC-midnight of a stored date's UTC day. */
const utcMidnight = (d) => {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};

/** Longest-first hostel-name containment with conservative context rules. */
const HOSTELS_BY_LEN = [...HOSTELS].sort((a, b) => b.length - a.length);
function matchHostelFramework(raw) {
  const s = norm(raw);
  if (!s) return null;
  for (const h of HOSTELS_BY_LEN) {
    if (!s.includes(h)) continue;
    if (s === h || s.startsWith(h)) return h;
    if (s.includes("הוסטל") || s.includes("הוסוטל") || s.includes("קהילה תומכת")) return h;
  }
  return null;
}
/** Venue place ("הוסטל ליבא") → hostel name. */
function matchHostelPlace(raw) {
  const s = norm(raw);
  if (!s) return null;
  for (const h of HOSTELS_BY_LEN) if (s.includes(h)) return h;
  return null;
}

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const now = new Date();

  const manualMapPath = path.join(__dirname, "migration-map.json");
  const manualMap = fs.existsSync(manualMapPath)
    ? JSON.parse(fs.readFileSync(manualMapPath, "utf8"))
    : {};

  const collNames = (await db.listCollections().toArray()).map((c) => c.name);

  /* ================= CUTOVER GUARD ================= */
  if (collNames.includes("zz_legacy_courseinstances")) {
    console.log("⛔ cutover already happened (zz_legacy_* exists) — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  /* ================= 0 · load sources ================= */
  console.log(`\n═══ remodel migration · mode: ${MODE} ═══\n`);
  const [users, students, teachers, courses, basecourses, cis, lessons] = await Promise.all([
    db.collection("users").find({}).toArray(),
    db.collection("students").find({}).toArray(),
    db.collection("teachers").find({}).toArray(),
    db.collection("courses").find({}).toArray(),
    db.collection("basecourses").find({}).toArray(),
    db.collection("courseinstances").find({}).toArray(),
    db.collection("lessons").find({}).toArray(),
  ]);

  const counts = {
    users: users.length,
    students: students.length,
    teachers: teachers.length,
    courses: courses.length,
    basecourses: basecourses.length,
    courseinstances: cis.length,
    lessons: lessons.length,
    enrolledRows: cis.reduce((n, ci) => n + (ci.enrolledStudents || []).length, 0),
    attendanceRows: lessons.reduce((n, l) => n + (l.attendanceRecords || []).length, 0),
    reservations: students.filter((s) => s.matching?.reservedCourse?.courseInstance).length,
  };
  report("counts", counts);

  /* ================= 1 · preconditions ================= */
  const courseById = new Map(courses.map((c) => [String(c._id), c]));
  const baseById = new Map(basecourses.map((b) => [String(b._id), b]));
  const bad = [];
  for (const ci of cis) {
    const course = courseById.get(String(ci.course));
    if (!course) bad.push({ ci: String(ci._id), problem: "course missing" });
    else if (!course.baseCourse || !baseById.get(String(course.baseCourse)))
      bad.push({ ci: String(ci._id), course: course.courseName, problem: "baseCourse unresolved" });
  }
  if (bad.length) {
    report("precondition-failures", bad);
    console.error(`⛔ ${bad.length} cycles cannot resolve a subject — run backfillBaseCourses.js first.`);
    process.exit(1);
  }
  const foreignUsers = users.filter((u) => !APP_ROLES.includes(u.role));
  report("foreign-users-left-in-place", foreignUsers.map((u) => ({ _id: String(u._id), role: u.role, hint: u.email || u.username })));

  /* ================= 2 · hostels ================= */
  const hostelDocs = HOSTELS.map((name) => ({
    _id: new ObjectId(),
    world: "real",
    name,
    active: true,
    createdAt: now,
    updatedAt: now,
  }));
  const hostelIdByName = new Map(hostelDocs.map((h) => [h.name, h._id]));

  /* ================= 3 · subjects (BaseCourse._id PRESERVED) ================= */
  const unmappedCategories = [];
  const subjectDocs = basecourses.map((b) => {
    const key = CATEGORY_MAP[norm(b.category)] || "other";
    if (key === "other" && b.category) unmappedCategories.push({ subject: b.name, category: b.category });
    return {
      _id: b._id, // ASSERTED below — every cycle.subject ref depends on this
      world: worldOf(b.dataset),
      name: norm(b.name),
      category: key,
      importAliases: [],
      active: true,
      createdAt: b.createdAt || now,
      updatedAt: now,
    };
  });
  report("subjects-unmapped-categories", unmappedCategories);
  for (const s of subjectDocs) {
    if (!SUBJECT_CATEGORY_KEYS.includes(s.category)) throw new Error(`bad category key ${s.category}`);
  }
  // Resolver: (world, raw string) → subject _id.
  //
  // Demo worlds (test/pokemon) were seeded on the REAL taxonomy — but in
  // the new model subjects are per-world ({world,name} unique) and cycles
  // must ref a subject of their own world. So, exactly like rooms, demo
  // worlds get CLONES of the real subjects they use, created on demand.
  const subjByKey = new Map(); // `${world}|${subjNorm(name)}` → _id
  for (const s of subjectDocs) subjByKey.set(`${s.world}|${subjNorm(s.name)}`, s._id);
  const subjectDocByIdStr = new Map(subjectDocs.map((s) => [String(s._id), s]));
  const extraSubjectDocs = []; // demo-world clones + demo-only demand subjects
  const cloneIdByKey = new Map(); // `${world}|${realIdStr}` → clone _id
  function subjectIdForWorld(world, realId) {
    const real = subjectDocByIdStr.get(String(realId));
    if (!real) return null;
    if (real.world === world) return real._id;
    const key = `${world}|${real._id}`;
    if (!cloneIdByKey.has(key)) {
      const doc = {
        _id: new ObjectId(),
        world,
        name: real.name,
        category: real.category,
        importAliases: [],
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      extraSubjectDocs.push(doc);
      cloneIdByKey.set(key, doc._id);
      subjByKey.set(`${world}|${subjNorm(real.name)}`, doc._id);
    }
    return cloneIdByKey.get(key);
  }
  const createdDemoSubjects = [];
  const aliasByKey = new Map(); // senzey course-name → REAL base id
  for (const c of courses) {
    if (!c.baseCourse) continue;
    const w = worldOf(c.dataset);
    const alias = norm(c.courseName);
    if (!alias) continue;
    aliasByKey.set(`${w}|${subjNorm(alias)}`, c.baseCourse);
    if (w === "real") {
      const subj = subjectDocByIdStr.get(String(c.baseCourse));
      if (subj && !subj.importAliases.includes(alias) && alias !== subj.name) subj.importAliases.push(alias);
    }
  }
  function resolveSubject(world, raw) {
    const n = subjNorm(raw);
    if (!n) return null;
    if (subjByKey.has(`${world}|${n}`)) return subjByKey.get(`${world}|${n}`);
    if (aliasByKey.has(`${world}|${n}`)) return subjectIdForWorld(world, aliasByKey.get(`${world}|${n}`));
    const manual = manualMap.subjects && manualMap.subjects[norm(raw)];
    if (manual && subjByKey.has(`${world}|${subjNorm(manual)}`)) return subjByKey.get(`${world}|${subjNorm(manual)}`);
    if (world !== "real") {
      // borrow from the real taxonomy → clone into this world
      const realHit =
        subjByKey.get(`real|${n}`) || (manual && subjByKey.get(`real|${subjNorm(manual)}`));
      if (realHit) return subjectIdForWorld(world, realHit);
      // genuinely demo-only vocabulary (e.g. the 4 course-less pokemon
      // types — real demand demo data) → create in that world
      const doc = {
        _id: new ObjectId(),
        world,
        name: norm(raw),
        category: world === "pokemon" ? "pokemon" : "other",
        importAliases: [],
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      extraSubjectDocs.push(doc);
      subjByKey.set(`${world}|${n}`, doc._id);
      createdDemoSubjects.push({ world, name: doc.name });
      return doc._id;
    }
    return null;
  }

  /* ================= 4 · rooms_v2 (built from the name strings) ================= */
  // The old rooms collection is empty and no ObjectId room ref exists in the
  // data (verified: 0 defaultRoom, 0 actualRoom) — rooms are born from the
  // location.room / requiredRooms strings of non-hostel cycles.
  const roomIdByKey = new Map(); // `${world}|${name}` → _id
  const roomDocs = [];
  function ensureRoom(world, rawName) {
    const name = norm(rawName);
    if (!name || name === "הוסטלים" || name === "חיצוני") return null; // placeholders, not rooms
    const key = `${world}|${name}`;
    if (!roomIdByKey.has(key)) {
      const doc = { _id: new ObjectId(), world, name, active: true, createdAt: now, updatedAt: now };
      roomDocs.push(doc);
      roomIdByKey.set(key, doc._id);
    }
    return roomIdByKey.get(key);
  }
  for (const ci of cis) {
    const world = worldOf(courseById.get(String(ci.course)).dataset);
    if (ci.location?.room && ci.location?.site !== "hostel") ensureRoom(world, ci.location.room);
    for (const r of ci.matching?.requiredRooms || []) ensureRoom(world, r);
  }

  /* ================= 5 · people (User._id PRESERVED) ================= */
  const studentByUser = new Map(students.map((s) => [String(s.user), s]));
  const teacherByUser = new Map(teachers.map((t) => [String(t.user), t]));
  const orphanProfiles = [];
  const userIds = new Set(users.map((u) => String(u._id)));
  for (const s of students) if (!userIds.has(String(s.user))) orphanProfiles.push({ kind: "student", _id: String(s._id) });
  for (const t of teachers) if (!userIds.has(String(t.user))) orphanProfiles.push({ kind: "teacher", _id: String(t._id) });
  report("orphan-profiles-skipped", orphanProfiles);

  const unmatchedInterests = [];
  const unmatchedTeacherSubjects = [];
  const frameworkMapping = [];
  const availableHoursDiff = [];
  const win = (w) => ({ day: w.day, start: w.from ?? w.start, end: w.to ?? w.end });

  const peopleDocs = [];
  for (const u of users) {
    if (!APP_ROLES.includes(u.role)) continue; // foreign app docs stay in `users`
    const world = worldOf(u.dataset);
    const p = {
      _id: u._id,
      world,
      role: u.role,
      firstName: u.firstName,
      lastName: u.lastName || "",
      phone: u.phone,
      birthDate: u.birthDate,
      gender: u.gender,
      senzeyId: u.senzeyId,
      joinedShekelDate: u.joinedShekelDate,
      avatar: u.avatar,
      availability: [],
      deletedAt: null,
      createdAt: u.createdAt || now,
      updatedAt: now,
    };
    if (u.email && !/@placeholder\.local$/i.test(u.email)) p.email = u.email.toLowerCase();
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    p.availability = [];

    if (u.role === "Teacher") {
      p.availability = (u.availability || []).map(win);
      const t = teacherByUser.get(String(u._id));
      const subjIds = new Set();
      const misses = [];
      if (t) {
        for (const raw of t.subjects || []) {
          const id = resolveSubject(world, raw);
          if (id) subjIds.add(String(id));
          else if (norm(raw)) misses.push(norm(raw));
        }
        for (const courseId of t.canTeachCourses || []) {
          const c = courseById.get(String(courseId));
          if (c?.baseCourse) {
            const id = subjectIdForWorld(world, c.baseCourse);
            if (id) subjIds.add(String(id));
          }
        }
        // The singular free-text `subject` ("מורה למוזיקה ופסנתר") is a
        // display label — consult it only when nothing else resolved.
        if (!subjIds.size && t.subject) {
          const id = resolveSubject(world, t.subject);
          if (id) subjIds.add(String(id));
          else if (norm(t.subject)) misses.push(norm(t.subject));
        }
        if ((t.availableHours || []).length) {
          availableHoursDiff.push({ teacher: `${u.firstName} ${u.lastName || ""}`, availableHours: t.availableHours });
        }
      }
      p.subjects = [...subjIds].map((id) => new ObjectId(id));
      if (misses.length) {
        p.import = { unmatchedSubjects: misses };
        unmatchedTeacherSubjects.push({ teacher: `${u.firstName} ${u.lastName || ""}`, world, raw: misses });
      }
    }

    if (u.role === "Student") {
      const s = studentByUser.get(String(u._id));
      if (s) {
        p.availability = (s.matching?.availability || []).map(win);
        if ((u.availability || []).length) p.availability.push(...u.availability.map(win));
        const tail = (s.stageHistory || [])[s.stageHistory?.length - 1];
        if (s.pipelineStage) {
          p.pipeline = { stage: s.pipelineStage, since: tail?.movedAt || s.updatedAt || u.updatedAt || now };
        }
        p.stageHistory = s.stageHistory || [];
        const interests = [];
        const misses = [];
        for (const raw of s.matching?.interests || []) {
          const id = resolveSubject(world, raw);
          if (id) interests.push(id);
          else if (norm(raw)) misses.push(norm(raw));
        }
        p.matching = {
          ...(s.matching?.functioningLevel && { functioningLevel: s.matching.functioningLevel }),
          ...(s.matching?.groupPreference && { groupPreference: s.matching.groupPreference }),
          interests,
        };
        if (misses.length) unmatchedInterests.push({ student: `${u.firstName} ${u.lastName || ""}`, world, raw: misses });
        if (s.framework) {
          const h = matchHostelFramework(s.framework);
          p.residence = { ...(h && { hostel: hostelIdByName.get(h) }), label: norm(s.framework) };
          frameworkMapping.push({ raw: norm(s.framework), hostel: h || null });
        }
        for (const k of ["address", "city", "notes", "emergencyContact", "emergencyPhone"]) {
          if (s[k]) p[k] = s[k];
        }
        if (s.caseCoordinator && Object.values(s.caseCoordinator).some(Boolean)) p.caseCoordinator = s.caseCoordinator;
        const imp = {
          ...(s.status && { statusLabel: s.status }),
          ...((s.type || []).length && { typeTags: s.type }),
          ...(s.registrationSource && { registrationSource: s.registrationSource }),
          ...(s.openedBy && { openedBy: s.openedBy }),
          ...(misses.length && { unmatchedInterests: misses }),
        };
        if (Object.keys(imp).length) p.import = imp;
      }
    }
    peopleDocs.push(p);
  }
  report("interests-unmatched", unmatchedInterests);
  report("teacher-subjects-unmatched", unmatchedTeacherSubjects);
  report("framework-mapping", [...new Map(frameworkMapping.map((f) => [f.raw, f])).values()]);
  report("teacher-availablehours-diff", availableHoursDiff);

  /* ================= 6 · cycles (CourseInstance._id PRESERVED) ================= */
  const unmatchedHostelStrings = [];
  const unmatchedRequiredRooms = [];
  const cycleDocs = [];
  const cycleById = new Map();
  for (const ci of cis) {
    const course = courseById.get(String(ci.course));
    const world = worldOf(course.dataset);
    const loc = ci.location || {};

    // -- single schedule source: weeklySchedule ∪ per-enrolment triples --
    const slotRoom =
      loc.site !== "hostel" && loc.room ? roomIdByKey.get(`${world}|${norm(loc.room)}`) || null : null;
    const slots = [];
    const slotKey = (d, s2, e) => `${d}|${s2}|${e}`;
    const seen = new Set();
    for (const ws of ci.weeklySchedule || []) {
      const k = slotKey(ws.day, ws.startTime, ws.endTime);
      if (seen.has(k)) continue;
      seen.add(k);
      slots.push({ _id: ws._id || new ObjectId(), day: ws.day, start: ws.startTime, end: ws.endTime, room: slotRoom });
    }
    for (const row of ci.enrolledStudents || []) {
      if (row.day == null || !row.startTime || !row.endTime) continue;
      const k = slotKey(row.day, row.startTime, row.endTime);
      if (seen.has(k)) continue;
      seen.add(k);
      slots.push({ _id: new ObjectId(), day: row.day, start: row.startTime, end: row.endTime, room: slotRoom });
    }
    slots.sort((a, b) => a.day - b.day || String(a.start).localeCompare(String(b.start)));

    // -- hostel (track) + venue (physical place) --
    let hostelRef = null;
    if (ci.hostel) {
      const h = hostelIdByName.get(norm(ci.hostel));
      if (h) hostelRef = h;
      else unmatchedHostelStrings.push({ cycle: String(ci._id), field: "hostel", raw: ci.hostel });
    }
    let venue;
    if (loc.site === "hostel") {
      const h = matchHostelPlace(loc.place);
      venue = {
        ...(h && { hostel: hostelIdByName.get(h) }),
        ...((loc.room || (!h && loc.place)) && { label: norm(loc.room || loc.place) }),
      };
      if (!h && loc.place) unmatchedHostelStrings.push({ cycle: String(ci._id), field: "venue", raw: loc.place });
    } else if (loc.site === "external") {
      venue = { ...(loc.place && { label: norm(loc.place) }) };
    }

    // -- matching rules: requiredRooms strings → refs --
    const reqIds = [];
    const reqMisses = [];
    for (const raw of ci.matching?.requiredRooms || []) {
      const id = roomIdByKey.get(`${world}|${norm(raw)}`);
      if (id) reqIds.push(id);
      else reqMisses.push(norm(raw));
    }
    if (reqMisses.length) unmatchedRequiredRooms.push({ cycle: String(ci._id), raw: reqMisses });

    const m = ci.matching || {};
    const doc = {
      _id: ci._id,
      world,
      subject: subjectIdForWorld(world, course.baseCourse),
      teacher: ci.mainTeacher || null,
      status: ci.status || "Active",
      startDate: ci.startDate,
      endDate: ci.endDate,
      schedule: slots,
      hostel: hostelRef,
      ...(venue && Object.keys(venue).length && { venue }),
      matching: {
        ...(m.ageMin != null && { ageMin: m.ageMin }),
        ...(m.ageMax != null && { ageMax: m.ageMax }),
        ...((m.functioningLevels || []).length && { functioningLevels: m.functioningLevels }),
        ...(m.format && { format: m.format }),
        ...(m.capacity != null && { capacity: m.capacity }),
        enrollmentOpen: m.enrollmentOpen !== false,
        ...(m.requirements && { requirements: m.requirements }),
        requiredRooms: reqIds,
      },
      import: {
        ...(course.courseId && { senzeyCourseId: course.courseId }),
        ...(course.courseName && { senzeyName: course.courseName }),
        ...(course.courseCategory && { senzeyCategory: course.courseCategory }),
        ...(loc.site !== "hostel" && loc.room && !roomIdByKey.get(`${world}|${norm(loc.room)}`) && { roomLabel: norm(loc.room) }),
        ...(reqMisses.length && { unmatchedRequiredRooms: reqMisses }),
      },
      createdAt: ci.createdAt || now,
      updatedAt: now,
    };
    cycleDocs.push(doc);
    cycleById.set(String(ci._id), doc);
  }
  report("hostel-strings-unmatched", unmatchedHostelStrings);
  report("requiredrooms-unmatched", unmatchedRequiredRooms);
  report("subjects-cloned-for-demo-worlds", extraSubjectDocs.filter((s) => !createdDemoSubjects.some((c) => c.world === s.world && c.name === s.name)).map((s) => ({ world: s.world, name: s.name })));
  report("subjects-created-for-demo-worlds", createdDemoSubjects);

  /* ================= 7 · enrollments ================= */
  const enrollmentDocs = [];
  const dedupedEnrollments = [];
  const pairSeen = new Map(); // `${cycle}|${student}` → doc
  for (const ci of cis) {
    const cyc = cycleById.get(String(ci._id));
    for (const row of ci.enrolledStudents || []) {
      const key = `${ci._id}|${row.student}`;
      const joinedAt = row.receivedDate || row.registrationDate || null;
      const leftAt = row.endDate || null;
      let status;
      if (row.isActive === false) status = "left";
      else if (cyc.status === "Cancelled") status = "left";
      else if (cyc.status === "Completed") status = "completed";
      else if (leftAt && new Date(leftAt) < now) status = "left";
      else status = "active";
      let slotId = null;
      if (cyc.schedule.length > 1 && row.day != null && row.startTime && row.endTime) {
        const hits = cyc.schedule.filter(
          (s) => s.day === row.day && s.start === row.startTime && s.end === row.endTime
        );
        if (hits.length === 1) slotId = hits[0]._id;
      }
      const doc = {
        _id: new ObjectId(),
        cycle: ci._id,
        student: row.student,
        world: cyc.world,
        status,
        slotId,
        joinedAt,
        registeredAt: row.registrationDate || null,
        leftAt,
        import: { ...(row.isActive !== undefined && { isActiveFlag: row.isActive }) },
        createdAt: row.registrationDate || ci.createdAt || now,
        updatedAt: now,
      };
      if (pairSeen.has(key)) {
        const prev = pairSeen.get(key);
        const keep =
          (prev.joinedAt ? new Date(prev.joinedAt) : Infinity) <= (doc.joinedAt ? new Date(doc.joinedAt) : Infinity)
            ? prev
            : doc;
        dedupedEnrollments.push({ cycle: String(ci._id), student: String(row.student) });
        pairSeen.set(key, keep);
      } else pairSeen.set(key, doc);
    }
  }
  for (const doc of pairSeen.values()) enrollmentDocs.push(doc);
  // Reservations → enrollment {status:'reserved'}
  const reservationConflicts = [];
  let reservationsMigrated = 0;
  for (const s of students) {
    const rc = s.matching?.reservedCourse;
    if (!rc?.courseInstance) continue;
    const cyc = cycleById.get(String(rc.courseInstance));
    if (!cyc) {
      reservationConflicts.push({ student: String(s.user), problem: "cycle missing", cycle: String(rc.courseInstance) });
      continue;
    }
    const key = `${rc.courseInstance}|${s.user}`;
    if (pairSeen.has(key)) {
      reservationConflicts.push({ student: String(s.user), cycle: String(rc.courseInstance), problem: "already enrolled" });
      continue;
    }
    const doc = {
      _id: new ObjectId(),
      cycle: cyc._id,
      student: s.user,
      world: cyc.world,
      status: "reserved",
      slotId: null,
      reservedAt: rc.reservedAt || now,
      ...(rc.note && { note: rc.note }),
      createdAt: rc.reservedAt || now,
      updatedAt: now,
    };
    pairSeen.set(key, doc);
    enrollmentDocs.push(doc);
    reservationsMigrated++;
  }
  report("enrollments-deduped", dedupedEnrollments);
  report("reservation-conflicts", reservationConflicts);

  /* ================= 8 · lessons_v2 ================= */
  const dateCollisions = [];
  const liveByKey = new Map();
  const lessonDocs = lessons.map((l) => {
    const cyc = cycleById.get(String(l.courseInstance));
    const source = l.isLegacy ? "archive" : "live";
    const date = source === "live" ? utcMidnight(l.date) : l.date;
    if (source === "live") {
      const k = `${l.courseInstance}|${date.toISOString()}`;
      if (liveByKey.has(k)) dateCollisions.push({ cycle: String(l.courseInstance), date: date.toISOString(), lessons: [liveByKey.get(k), String(l._id)] });
      else liveByKey.set(k, String(l._id));
    }
    return {
      _id: l._id,
      cycle: l.courseInstance,
      date,
      teacher: l.actualTeacher || null,
      room: null, // verified: zero actualRoom refs exist in the data
      source,
      world: cyc ? cyc.world : "real",
      attendance: (l.attendanceRecords || []).map((r) => ({
        _id: r._id || new ObjectId(),
        student: r.student,
        status: r.status,
        ...(r.note && { note: r.note }),
        ...(r.progressRating != null && { progressRating: r.progressRating }),
        isGuest: r.isOriginalGroupMember === false, // INVERSION, not a rename
      })),
      createdAt: l.createdAt || now,
      updatedAt: l.updatedAt || now,
    };
  });
  const lessonsWithoutCycle = lessons.filter((l) => !cycleById.has(String(l.courseInstance)));
  report("lessons-without-cycle", lessonsWithoutCycle.map((l) => String(l._id)));
  report("lesson-date-collisions", dateCollisions);
  if (dateCollisions.length && MODE !== "dry-run") {
    console.error("⛔ live-lesson date collisions — merge manually before --apply.");
    process.exit(1);
  }

  /* ================= 9 · verify (reconciliation formulas) ================= */
  const allSubjectDocs = [...subjectDocs, ...extraSubjectDocs];
  const allSubjectIds = new Set(allSubjectDocs.map((s) => String(s._id)));
  const verify = {
    people: { expected: users.length - foreignUsers.length, actual: peopleDocs.length },
    subjects: {
      expected: basecourses.length + extraSubjectDocs.length,
      actual: allSubjectDocs.length,
    },
    cycles: { expected: cis.length, actual: cycleDocs.length },
    enrollments: {
      expected: counts.enrolledRows - dedupedEnrollments.length + reservationsMigrated,
      actual: enrollmentDocs.length,
    },
    lessons: { expected: lessons.length, actual: lessonDocs.length },
    hostels: { expected: HOSTELS.length, actual: hostelDocs.length },
    subjectIdPreserved: basecourses.every((b, i) => String(subjectDocs[i]._id) === String(b._id)),
    cycleIdPreserved: cycleDocs.every((c, i) => String(c._id) === String(cis[i]._id)),
    everyCycleSubjectResolves: cycleDocs.every((c) => c.subject && allSubjectIds.has(String(c.subject))),
    everyEnrollmentCycleResolves: enrollmentDocs.every((e) => cycleById.has(String(e.cycle))),
    everySlotIdResolves: enrollmentDocs.every(
      (e) => !e.slotId || cycleById.get(String(e.cycle)).schedule.some((s) => String(s._id) === String(e.slotId))
    ),
    zeroMissingWorld:
      peopleDocs.every((p) => p.world) &&
      cycleDocs.every((c) => c.world) &&
      enrollmentDocs.every((e) => e.world) &&
      lessonDocs.every((l) => l.world),
  };
  report("verify", verify);
  const verifyOk =
    Object.values(verify).every((v) => (typeof v === "boolean" ? v : v.expected === v.actual));
  console.log(verifyOk ? "\n✅ VERIFY passed" : "\n⛔ VERIFY FAILED — see reports");
  if (!verifyOk && MODE !== "dry-run") process.exit(1);

  if (MODE === "dry-run") {
    console.log("\n(dry-run — nothing written)");
    await mongoose.disconnect();
    return;
  }

  /* ================= 10 · APPLY: drop + rebuild the NEW collections ================= */
  if (MODE === "apply" || MODE === "cutover") {
    const targets = ["people", "subjects", "cycles", "enrollments", "hostels", "lessons_v2", "rooms_v2"];
    if (MODE === "apply") {
      for (const t of targets) if (collNames.includes(t)) await db.collection(t).drop();
      const ins = async (name, docs) => docs.length && (await db.collection(name).insertMany(docs));
      await ins("hostels", hostelDocs);
      await ins("subjects", allSubjectDocs);
      await ins("rooms_v2", roomDocs);
      await ins("people", peopleDocs);
      await ins("cycles", cycleDocs);
      await ins("enrollments", enrollmentDocs);
      await ins("lessons_v2", lessonDocs);
      console.log(
        `\n✅ built: people ${peopleDocs.length} · subjects ${allSubjectDocs.length} · cycles ${cycleDocs.length} · ` +
          `enrollments ${enrollmentDocs.length} · lessons_v2 ${lessonDocs.length} · rooms_v2 ${roomDocs.length} · hostels ${hostelDocs.length}`
      );

      // Indexes — identical specs to the Mongoose schemas.
      const ix = (name, keys, opts) => db.collection(name).createIndex(keys, opts || {});
      await ix("people", { world: 1, role: 1 });
      await ix("people", { world: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true } } });
      await ix("people", { world: 1, senzeyId: 1 }, { unique: true, partialFilterExpression: { senzeyId: { $exists: true } } });
      await ix("people", { world: 1, "pipeline.stage": 1, "pipeline.since": 1 });
      await ix("people", { world: 1, "matching.interests": 1 });
      await ix("people", { world: 1, subjects: 1 });
      await ix("subjects", { world: 1, name: 1 }, { unique: true });
      await ix("subjects", { world: 1, category: 1 });
      await ix("cycles", { world: 1, status: 1 });
      await ix("cycles", { world: 1, subject: 1 });
      await ix("cycles", { world: 1, teacher: 1 });
      await ix("cycles", { world: 1, hostel: 1 });
      await ix("cycles", { world: 1, "import.senzeyCourseId": 1 }, { unique: true, partialFilterExpression: { "import.senzeyCourseId": { $exists: true } } });
      await ix("enrollments", { cycle: 1, student: 1 }, { unique: true });
      await ix("enrollments", { student: 1, status: 1 });
      await ix("enrollments", { cycle: 1, status: 1 });
      await ix("enrollments", { world: 1, status: 1 });
      await ix("lessons_v2", { cycle: 1, date: 1 }, { unique: true, partialFilterExpression: { source: "live" } });
      await ix("lessons_v2", { cycle: 1, source: 1, date: 1 });
      await ix("lessons_v2", { "attendance.student": 1, date: -1 });
      await ix("lessons_v2", { world: 1, date: 1 });
      await ix("rooms_v2", { world: 1, name: 1 }, { unique: true });
      await ix("hostels", { world: 1, name: 1 }, { unique: true });
      console.log("✅ indexes created");
    }
  }

  /* ================= 11 · CUTOVER ================= */
  if (MODE === "cutover") {
    const need = ["people", "subjects", "cycles", "enrollments", "hostels", "lessons_v2", "rooms_v2"];
    const have = (await db.listCollections().toArray()).map((c) => c.name);
    for (const n of need) {
      if (!have.includes(n) || (await db.collection(n).countDocuments()) === 0) {
        if (n === "rooms_v2" && roomDocs.length === 0) continue;
        console.error(`⛔ ${n} missing/empty — run --apply first.`);
        process.exit(1);
      }
    }
    // App-only legacy collections → zz_legacy_*. `users` is SHARED with other
    // apps and is deliberately left untouched (the app just stops reading it).
    const renames = [
      ["students", "zz_legacy_students"],
      ["teachers", "zz_legacy_teachers"],
      ["courses", "zz_legacy_courses"],
      ["basecourses", "zz_legacy_basecourses"],
      ["lessons", "zz_legacy_lessons"],
      ["rooms", "zz_legacy_rooms"],
    ];
    for (const [from, to] of renames) {
      if (have.includes(from)) {
        await db.collection(from).rename(to, { dropTarget: false });
        console.log(`  ${from} → ${to}`);
      }
    }
    await db.collection("lessons_v2").rename("lessons");
    console.log("  lessons_v2 → lessons");
    await db.collection("rooms_v2").rename("rooms");
    console.log("  rooms_v2 → rooms");
    console.log("\n✅ CUTOVER complete. `users` left in place (shared with other apps).");
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
