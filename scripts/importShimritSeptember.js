/**
 * @file importShimritSeptember - שמרית's September 2026 picture of the
 * hostels (her answers of 2026-10-19), merged into the app: the houses
 * with their address, contact, Ministry numbers and courses; the teachers
 * with phone and rate; the residents of every house, seated in its
 * courses.
 *
 * A MERGE, never a replacement: whatever the app already holds is matched
 * by name (both name orders, a `match` hint in the file when her spelling
 * differs) and completed; only what is missing is made. Nothing is
 * removed - a seat or a person the app has and her file lacks is listed
 * in the report for שמרית to judge.
 *
 * Usage:
 *   node scripts/importShimritSeptember.js --dry    what would happen, no writes
 *   node scripts/importShimritSeptember.js          do it
 *   node scripts/importShimritSeptember.js --undo   take back what a run made (its ledger)
 *
 * The ledger (server/backups/import-shimrit.json, gitignored)
 * remembers every row it created and the fields it changed, so `--undo`
 * removes exactly those rows and puts the changed fields back.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const { PersonTag, PersonTagEvent } = require("../models/PersonTag");
const CycleTag = require("../models/CycleTag");
const Subject = require("../models/Subject");
const Hostel = require("../models/Hostel");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const tags = require("../services/tagService");
const { createPersonWithProfile } = require("../services/profileService");
const { enroll } = require("../services/enrollmentService");
const { createResident, ensureResidence } = require("../services/hostelReportService");
const { SUBJECT_CATEGORY_KEYS } = require("../utils/domain");

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith("--") ? a.slice(2).split("=") : [a, true])).map(([k, v]) => [k, v === undefined ? true : v]));
const DRY = !!args.dry;
const UNDO = !!args.undo;
const DATA = path.resolve(__dirname, args.data || "../../project-files/data/hostels/shimrit-2026-09.json");
const LEDGER = path.join(__dirname, "..", "backups", "import-shimrit.json");
const BY = "ייבוא ספטמבר 2026 (שמרית)";

/* ───────────────────────── names ───────────────────────── */

const norm = (s) =>
  String(s || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/["'’`´\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokensOf = (s) => norm(s).split(" ").filter((t) => t.length > 1);
const fullName = (p) => norm(`${p.firstName || ""} ${p.lastName || ""}`);
const sameSet = (a, b) => a.length === b.length && a.every((t) => b.includes(t));

/** first / last of a NEW person from the file's entry. */
function splitName(entry) {
  if (entry.first) return { firstName: entry.first, lastName: entry.last || "" };
  const parts = norm(entry.name).split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  if (entry.lf) return { firstName: parts.slice(1).join(" "), lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/* ───────────────────────── the ledger ───────────────────────── */

const ledger = { at: new Date().toISOString(), data: DATA, created: { subjects: [], hostels: [], people: [], profiles: [], cycles: [], enrollments: [], personTags: [] }, updated: [] };
const writeLedger = () => {
  if (DRY) return;
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
};
const created = (kind, doc) => {
  ledger.created[kind].push(String(doc._id));
  writeLedger();
  return doc;
};
/** Remember a field's old value once, before changing it. */
const touched = (model, doc, field) => {
  const id = String(doc._id);
  let row = ledger.updated.find((u) => u.model === model && u.id === id);
  if (!row) {
    row = { model, id, before: {} };
    ledger.updated.push(row);
  }
  if (!(field in row.before)) row.before[field] = doc[field] === undefined ? null : JSON.parse(JSON.stringify(doc[field]));
  writeLedger();
};

const report = { subjects: [], hostels: [], teachers: [], cycles: [], people: [], seats: [], unmatchedSeats: [], ambiguous: [], warnings: [] };
const log = (bucket, line) => {
  report[bucket].push(line);
  console.log(`  ${line}`);
};

/* ───────────────────────── undo ───────────────────────── */

const UNDO_MODELS = { enrollments: Enrollment, cycles: Cycle, profiles: Profile, people: Person, hostels: Hostel, subjects: Subject };

async function undo() {
  if (!fs.existsSync(LEDGER)) {
    console.log(`No ledger at ${LEDGER} - nothing to undo.`);
    return;
  }
  const led = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const out = [];
  for (const [kind, Model] of Object.entries(UNDO_MODELS)) {
    const ids = led.created[kind] || [];
    if (!ids.length) continue;
    if (kind === "cycles") await CycleTag.deleteMany({ cycle: { $in: ids } });
    if (kind === "people") {
      const rows = await PersonTag.find({ person: { $in: ids } }).select("_id").lean();
      await PersonTagEvent.deleteMany({ personTag: { $in: rows.map((r) => r._id) } });
      await PersonTag.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    }
    const r = await Model.deleteMany({ _id: { $in: ids } });
    out.push(`${kind} ${r.deletedCount}`);
  }
  // tags given to people who were already there
  const tagIds = led.created.personTags || [];
  if (tagIds.length) {
    await PersonTagEvent.deleteMany({ personTag: { $in: tagIds } });
    out.push(`personTags ${(await PersonTag.deleteMany({ _id: { $in: tagIds } })).deletedCount}`);
  }
  // the fields changed on rows that were already there
  let restored = 0;
  for (const u of led.updated || []) {
    const Model = { Hostel, Cycle, Person, Profile, Enrollment }[u.model];
    if (!Model) continue;
    const doc = await Model.findById(u.id);
    if (!doc) continue;
    for (const [k, v] of Object.entries(u.before)) doc[k] = v === null ? undefined : v;
    await doc.save({ validateBeforeSave: false });
    restored++;
  }
  out.push(`restored ${restored}`);
  fs.unlinkSync(LEDGER);
  console.log(`Undone: ${out.join(" · ")}`);
}

/* ───────────────────────── the import ───────────────────────── */

async function main() {
  await connectDB();
  if (UNDO) return undo();
  if (fs.existsSync(LEDGER) && !DRY) {
    console.error(`A ledger of an earlier run exists (${LEDGER}). Run --undo first, or remove it to run on top.`);
    process.exitCode = 1;
    return;
  }
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const D = data.defaults;
  const alias = (name) => data.subjectAliases?.[name] || name;
  console.log(`${DRY ? "DRY RUN" : "IMPORT"} from ${path.basename(DATA)}`);
  if (!DRY) await tags.ensureCatalog();

  /* 1 ── subjects */
  console.log("\nSubjects");
  const subjectByName = new Map((await Subject.find({}).lean()).map((s) => [s.name, s]));
  const wantedSubjects = new Set([...data.subjects.map((s) => s.name), ...data.hostels.flatMap((h) => h.courses.map((c) => alias(c.subject))), ...data.teachers.flatMap((t) => t.subjects.map(alias))]);
  for (const name of wantedSubjects) {
    if (subjectByName.has(name)) continue;
    const spec = data.subjects.find((s) => s.name === name) || { category: "other" };
    log("subjects", `+ מקצוע חדש: ${name} (${spec.category})`);
    if (DRY) subjectByName.set(name, { _id: new mongoose.Types.ObjectId(), name });
    else subjectByName.set(name, created("subjects", await Subject.create({ name, category: SUBJECT_CATEGORY_KEYS.includes(spec.category) ? spec.category : "other", active: true })));
  }
  const subjectId = (name) => subjectByName.get(alias(name))?._id;

  /* 2 ── the houses */
  console.log("\nHostels");
  const hostelByName = new Map((await Hostel.find({})).map((h) => [h.name, h]));
  for (const h of data.hostels) {
    let doc = hostelByName.get(h.name);
    const fields = { kind: h.kind, address: h.address, city: h.city || D.city, notes: h.notes, approvals: h.approvals ?? undefined, since: h.since ? new Date(h.since) : undefined };
    if (!doc) {
      log("hostels", `+ ${h.kind === "community" ? "קהילה" : h.kind === "both" ? "הוסטל וקהילה" : "הוסטל"} חדש: ${h.name}`);
      if (DRY) doc = { _id: new mongoose.Types.ObjectId(), name: h.name, kind: h.kind, contacts: h.contacts, isNew: true };
      else doc = created("hostels", await Hostel.create({ name: h.name, contacts: h.contacts, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) }));
      hostelByName.set(h.name, doc);
      continue;
    }
    const changes = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const cur = doc[k] instanceof Date ? doc[k].toISOString() : doc[k];
      const next = v instanceof Date ? v.toISOString() : v;
      if (cur === next || (cur == null && next === "")) continue;
      if (k === "notes" && doc.notes) continue; // never overwrite a note the coordinator wrote
      changes.push(`${k}: ${cur ?? "-"} → ${k === "since" ? String(v).slice(0, 10) : v}`);
      if (!DRY) {
        touched("Hostel", doc, k);
        doc[k] = v;
      }
    }
    if (!(doc.contacts || []).length && h.contacts.length) {
      changes.push(`contacts: ${h.contacts.map((c) => c.name).join(", ")}`);
      if (!DRY) {
        touched("Hostel", doc, "contacts");
        doc.contacts = h.contacts;
      }
    } else if ((doc.contacts || []).length && h.contacts.length) {
      for (const c of h.contacts) {
        if (doc.contacts.some((x) => norm(x.name) === norm(c.name))) continue;
        changes.push(`contact +${c.name}`);
        if (!DRY) {
          touched("Hostel", doc, "contacts");
          doc.contacts.push(c);
        }
      }
    }
    if (changes.length) {
      log("hostels", `~ ${h.name}: ${changes.join(" · ")}`);
      if (!DRY) await doc.save();
    } else log("hostels", `= ${h.name}: ללא שינוי`);
  }

  /* 3 ── the teachers */
  console.log("\nTeachers");
  const teacherProfiles = await Profile.find({ kind: "Teacher" }).lean();
  const teacherPeople = await Person.find({ _id: { $in: teacherProfiles.map((p) => p.person) }, deletedAt: null });
  const teacherByName = new Map(); // the file's name → Person doc
  for (const t of data.teachers) {
    const want = tokensOf(t.name);
    const cands = teacherPeople.filter((p) => {
      const have = tokensOf(fullName(p));
      if (want.length === 1) return have[0] === want[0] || p.firstName === t.name;
      return want.filter((w) => have.includes(w)).length >= Math.min(2, want.length);
    });
    let person = cands[0];
    if (cands.length > 1) {
      log("ambiguous", `מורה "${t.name}" מתאים/ה ל-${cands.map(fullName).join(" / ")} - נבחר/ה ${fullName(person)}`);
    }
    const profile = person && teacherProfiles.find((p) => String(p.person) === String(person._id));
    if (!person) {
      const { firstName, lastName } = splitName({ name: t.name });
      log("teachers", `+ מורה חדש/ה: ${t.name} (${t.subjects.join(", ")}${t.rate ? `, ${t.rate} ₪` : ""})`);
      if (DRY) person = { _id: new mongoose.Types.ObjectId(), firstName, lastName };
      else {
        const made = await createPersonWithProfile("Teacher", { firstName, lastName, gender: t.gender, phone: t.phone, subjects: t.subjects.map(subjectId).filter(Boolean), hostelRate: t.rate ?? undefined, notes: t.note }, { opened: { by: BY } });
        person = created("people", made.person);
        created("profiles", made.profile);
        const row = await tags.give({ personId: person._id, key: "hostels", by: BY, note: "מורה בהוסטלים" });
        if (row) ledger.created.personTags.push(String(row._id));
        writeLedger();
      }
      teacherByName.set(t.name, person);
      continue;
    }
    const changes = [];
    if (t.phone && !person.phone) {
      changes.push(`טלפון ${t.phone}`);
      if (!DRY) {
        touched("Person", person, "phone");
        person.phone = t.phone;
        await person.save();
      }
    }
    if (t.gender && !person.gender) {
      changes.push(`מין ${t.gender}`);
      if (!DRY) {
        touched("Person", person, "gender");
        person.gender = t.gender;
        await person.save();
      }
    }
    if (profile && t.rate != null && profile.hostelRate !== t.rate) {
      changes.push(`תעריף ${profile.hostelRate ?? "-"} → ${t.rate} ₪`);
      if (!DRY) {
        const doc = await Profile.findById(profile._id);
        touched("Profile", doc, "hostelRate");
        doc.hostelRate = t.rate;
        await doc.save();
      }
    }
    const missingSubjects = t.subjects.map(alias).filter((n) => subjectId(n) && !(profile?.subjects || []).some((s) => String(s) === String(subjectId(n))));
    if (profile && missingSubjects.length) {
      changes.push(`מקצועות +${missingSubjects.join(", ")}`);
      if (!DRY) {
        const doc = await Profile.findById(profile._id);
        touched("Profile", doc, "subjects");
        doc.subjects = [...(doc.subjects || []), ...missingSubjects.map(subjectId)];
        await doc.save();
      }
    }
    if (!DRY && !(await tags.holds(person._id, "hostels"))) {
      const row = await tags.give({ personId: person._id, key: "hostels", by: BY, note: "מורה בהוסטלים" });
      if (row) ledger.created.personTags.push(String(row._id));
      writeLedger();
      changes.push("תג הוסטלים");
    }
    log("teachers", `${changes.length ? "~" : "="} ${t.name} → ${fullName(person)}${changes.length ? `: ${changes.join(" · ")}` : ""}`);
    teacherByName.set(t.name, person);
  }

  /* 4 ── the courses */
  console.log("\nCourses");
  const endDate = new Date(D.endDate);
  const cycleOf = new Map(); // `${hostel}|${subject}` → cycle doc
  for (const h of data.hostels) {
    const hostel = hostelByName.get(h.name);
    const existing = hostel.isNew ? [] : await Cycle.find({ hostel: hostel._id, status: { $ne: "Cancelled" } }).sort({ endDate: -1 });
    for (const c of h.courses) {
      const subj = subjectId(c.subject);
      if (!subj) {
        log("warnings", `${h.name}: המקצוע "${c.subject}" לא נמצא`);
        continue;
      }
      const teacher = c.teacher ? teacherByName.get(c.teacher) : null;
      const minutes = c.minutes || D.sessionMinutes;
      const end = c.start ? `${String(Math.floor((Number(c.start.split(":")[0]) * 60 + Number(c.start.split(":")[1]) + minutes) / 60)).padStart(2, "0")}:${String((Number(c.start.split(":")[0]) * 60 + Number(c.start.split(":")[1]) + minutes) % 60).padStart(2, "0")}` : null;
      const slot = Number.isInteger(c.day) && c.start ? { day: c.day, start: c.start, end } : null;
      const key = `${hostel._id}|${subj}`;
      let cycle = existing.find((x) => String(x.subject) === String(subj));
      const label = `${alias(c.subject)} @${h.name}`;
      if (!cycle) {
        log("cycles", `+ קורס חדש: ${label}${teacher ? ` · ${fullName(teacher)}` : " · ללא מורה"}${slot ? ` · יום ${["א", "ב", "ג", "ד", "ה", "ו", "ש"][slot.day]} ${slot.start}-${slot.end}` : " · ללא מועד"}${c.atShekel ? " · בשק״ל" : ""}`);
        if (DRY) cycle = { _id: new mongoose.Types.ObjectId(), schedule: slot ? [slot] : [] };
        else {
          cycle = created("cycles", await Cycle.create({ subject: subj, teacher: teacher?._id || null, status: "Active", startDate: new Date(D.startDate), endDate, schedule: slot ? [slot] : [], hostel: hostel._id, venue: c.atShekel ? { label: "שק״ל" } : { hostel: hostel._id }, matching: { enrollmentOpen: true } }));
          await tags.setCycleProgram({ cycleId: cycle._id, key: "hostels" });
        }
        cycleOf.set(key, cycle);
        continue;
      }
      const changes = [];
      if (teacher && !cycle.teacher) {
        changes.push(`מורה ${fullName(teacher)}`);
        if (!DRY) {
          touched("Cycle", cycle, "teacher");
          cycle.teacher = teacher._id;
        }
      } else if (teacher && String(cycle.teacher) !== String(teacher._id)) {
        log("warnings", `${label}: באפליקציה מורה אחר/ת (${String(cycle.teacher)}) - לפי הקובץ ${fullName(teacher)}; לא שונה`);
      }
      if (slot) {
        const cur = (cycle.schedule || []).filter((s) => Number.isInteger(s.day) && s.start);
        if (!cur.length) {
          changes.push(`מועד יום ${["א", "ב", "ג", "ד", "ה", "ו", "ש"][slot.day]} ${slot.start}-${slot.end}`);
          if (!DRY) {
            touched("Cycle", cycle, "schedule");
            cycle.schedule.push(slot);
          }
        } else if (cur.length === 1 && (cur[0].day !== slot.day || cur[0].start !== slot.start)) {
          changes.push(`מועד יום ${["א", "ב", "ג", "ד", "ה", "ו", "ש"][cur[0].day]} ${cur[0].start} → יום ${["א", "ב", "ג", "ד", "ה", "ו", "ש"][slot.day]} ${slot.start}-${slot.end}`);
          if (!DRY) {
            touched("Cycle", cycle, "schedule");
            const s = cycle.schedule.find((x) => Number.isInteger(x.day) && x.start);
            s.day = slot.day;
            s.start = slot.start;
            s.end = slot.end;
          }
        } else if (cur.length > 1) log("warnings", `${label}: כמה מועדים באפליקציה - לא נגעתי`);
      }
      if (cycle.endDate < endDate) {
        changes.push(`סיום ${cycle.endDate.toISOString().slice(0, 10)} → ${D.endDate}`);
        if (!DRY) {
          touched("Cycle", cycle, "endDate");
          cycle.endDate = endDate;
        }
      }
      if (!DRY && changes.length) await cycle.save();
      if (!DRY) await tags.setCycleProgram({ cycleId: cycle._id, key: "hostels" });
      log("cycles", `${changes.length ? "~" : "="} ${label}${changes.length ? `: ${changes.join(" · ")}` : ""}`);
      cycleOf.set(key, cycle);
    }
    for (const x of existing) {
      if (![...cycleOf.values()].some((c) => String(c._id) === String(x._id))) {
        const s = subjectByName.get([...subjectByName.values()].find((v) => String(v._id) === String(x.subject))?.name)?.name || String(x.subject);
        log("unmatchedSeats", `${h.name}: הקורס "${s}" קיים באפליקציה ולא ברשימה של שמרית (מסתיים ${x.endDate.toISOString().slice(0, 10)})`);
      }
    }
  }

  /* 5 ── the people */
  console.log("\nPeople");
  const everyone = await Person.find({ deletedAt: null });
  const hostelsTagHolders = new Set();
  {
    const tag = (await tags.tagMap()).get("hostels");
    if (tag) for (const row of await PersonTag.find({ tag: tag._id, until: null }).select("person").lean()) hostelsTagHolders.add(String(row.person));
  }
  const seatsBefore = await Enrollment.find({ status: { $in: ["active", "reserved"] } }).select("cycle student").lean();
  const seated = new Set(seatsBefore.map((e) => `${e.cycle}|${e.student}`));
  const listedSeats = new Set();
  let made = 0;
  let matched = 0;
  /** Among several people of the same name: the one seated in this house's courses, else the one in the הוסטלים program, else none. */
  const prefer = (hits, hostelCycleIds) => {
    if (hits.length <= 1) return hits;
    const inHouse = hits.filter((p) => hostelCycleIds.some((cid) => seated.has(`${cid}|${p._id}`)));
    if (inHouse.length === 1) return inHouse;
    const inHostels = hits.filter((p) => hostelsTagHolders.has(String(p._id)));
    return inHostels.length === 1 ? inHostels : hits;
  };
  for (const h of data.hostels) {
    const hostel = hostelByName.get(h.name);
    const courseKeys = h.courses.map((c) => `${hostel._id}|${subjectId(c.subject)}`).filter((k) => cycleOf.has(k));
    const hostelCycleIds = courseKeys.map((k) => String(cycleOf.get(k)._id));
    for (const entry of h.residents) {
      // who is this
      let person = null;
      if (entry.match) {
        const want = tokensOf(entry.match);
        const hits = prefer(everyone.filter((p) => sameSet(tokensOf(fullName(p)), want)), hostelCycleIds);
        if (hits.length > 1) {
          log("ambiguous", `${h.name}: "${entry.name}" עם רמז "${entry.match}" - ${hits.length} התאמות; דולג/ת`);
          continue;
        }
        if (!hits.length) log("warnings", `${h.name}: הרמז "${entry.match}" ל"${entry.name}" לא נמצא באפליקציה - נוצר/ה כחדש/ה`);
        person = hits[0] || null;
      } else {
        const want = tokensOf(entry.name);
        let hits = everyone.filter((p) => {
          const have = tokensOf(fullName(p));
          const shared = want.filter((w) => have.includes(w)).length;
          return shared >= 2 || (want.length === 1 && shared === 1) || sameSet(have, want);
        });
        if (hits.length > 1) {
          const exact = hits.filter((p) => sameSet(tokensOf(fullName(p)), want));
          hits = prefer(exact.length === 1 ? exact : hits, hostelCycleIds);
        }
        if (hits.length > 1) {
          log("ambiguous", `${h.name}: "${entry.name}" מתאים/ה ל-${hits.map(fullName).join(" / ")}; דולג/ת`);
          continue;
        }
        person = hits[0] || null;
      }
      const wantCourses = entry.courses ? entry.courses.map((n) => `${hostel._id}|${subjectId(n)}`).filter((k) => cycleOf.has(k)) : courseKeys;
      const courseNames = wantCourses.map((k) => alias(h.courses.find((c) => `${hostel._id}|${subjectId(c.subject)}` === k)?.subject));
      if (!person) {
        const { firstName, lastName } = splitName(entry);
        made++;
        log("people", `+ ${h.name}: ${firstName} ${lastName} (חדש/ה)${entry.note ? ` · ${entry.note}` : ""} → ${courseNames.join(", ") || "ללא קורס"}`);
        if (DRY) {
          // a new person's seats are counted here too, so the dry run's seat count is the run's
          for (const k of wantCourses) {
            listedSeats.add(`${cycleOf.get(k)._id}|new`);
            log("seats", `+ ${firstName} ${lastName} → ${alias(h.courses.find((c) => `${hostel._id}|${subjectId(c.subject)}` === k)?.subject)} @${h.name}`);
          }
          continue;
        }
        const r = await createResident({ firstName, lastName, hostel: hostel._id, since: new Date(D.residenceSince), notes: entry.note ? `${entry.note} (${BY})` : `${BY}`, by: BY });
        created("people", r.person);
        created("profiles", r.profile);
        person = r.person;
      } else {
        matched++;
        const changes = [];
        if (!DRY) {
          if (!hostelsTagHolders.has(String(person._id))) {
            const row = await tags.give({ personId: person._id, key: "hostels", by: BY, note: "דייר/ת בהוסטל" });
            if (row) ledger.created.personTags.push(String(row._id));
            hostelsTagHolders.add(String(person._id));
            changes.push("תג הוסטלים");
          }
          const profBefore = await Profile.findOne({ person: person._id, kind: "StudentCollege" });
          const livesHere = profBefore && String(profBefore.residence?.hostel || "") === String(hostel._id) && !(profBefore.residence?.until && profBefore.residence.until <= new Date());
          if (!livesHere) {
            if (profBefore) touched("Profile", profBefore, "residence");
            const prof = await ensureResidence({ personId: person._id, hostel: hostel._id, since: new Date(D.residenceSince), by: BY });
            if (!profBefore) created("profiles", prof);
            changes.push(`מגורים: ${profBefore?.residence?.label || profBefore?.residence?.hostel || "-"} → ${h.name}`);
          }
        } else {
          if (!hostelsTagHolders.has(String(person._id))) changes.push("תג הוסטלים");
          const prof = await Profile.findOne({ person: person._id, kind: "StudentCollege" }).lean();
          const livesHere = prof && String(prof.residence?.hostel || "") === String(hostel._id);
          if (!livesHere) changes.push(`מגורים: ${prof?.residence?.label || "-"} → ${h.name}`);
        }
        log("people", `= ${h.name}: "${entry.name}" → ${fullName(person)}${changes.length ? ` · ${changes.join(" · ")}` : ""}${entry.note ? ` · ${entry.note}` : ""}`);
      }
      // the seats
      for (const k of wantCourses) {
        const cycle = cycleOf.get(k);
        const seatKey = `${cycle._id}|${person._id}`;
        listedSeats.add(seatKey);
        if (seated.has(seatKey)) continue;
        const name = alias(h.courses.find((c) => `${hostel._id}|${subjectId(c.subject)}` === k)?.subject);
        if (DRY) {
          log("seats", `+ ${fullName(person)} → ${name} @${h.name}`);
          continue;
        }
        try {
          const e = await enroll({ cycleId: cycle._id, studentId: person._id, status: "active", createdBy: BY, joinedAt: new Date(D.residenceSince), note: "לפי רשימת ספטמבר 2026 של שמרית" });
          created("enrollments", e);
          seated.add(seatKey);
          log("seats", `+ ${fullName(person)} → ${name} @${h.name}`);
        } catch (e) {
          log("warnings", `${fullName(person)} → ${name} @${h.name}: ${e.code || e.message}`);
        }
      }
    }
  }

  /* 6 ── what the app has and her list lacks (nothing is removed): seats in HER courses held by people not on her list */
  const herCycleIds = new Set([...cycleOf.values()].map((c) => String(c._id)));
  const hostelCycles = await Cycle.find({ hostel: { $ne: null } }).populate("subject", "name").populate("hostel", "name").lean();
  const byCycle = new Map(hostelCycles.map((c) => [String(c._id), c]));
  for (const e of seatsBefore) {
    const c = byCycle.get(String(e.cycle));
    if (!c || !herCycleIds.has(String(c._id))) continue;
    if (listedSeats.has(`${e.cycle}|${e.student}`)) continue;
    const p = everyone.find((x) => String(x._id) === String(e.student));
    log("unmatchedSeats", `${c.hostel?.name}: ${p ? fullName(p) : e.student} יושב/ת ב"${c.subject?.name}" באפליקציה ולא ברשימה של שמרית`);
  }

  writeLedger();
  console.log(`\n${DRY ? "Would do" : "Done"}: ${report.subjects.length} subjects · ${report.hostels.filter((l) => l[0] !== "=").length} hostels changed · ${report.teachers.filter((l) => l[0] !== "=").length} teachers changed · ${report.cycles.filter((l) => l[0] !== "=").length} courses changed · people: ${matched} matched, ${made} new · ${report.seats.length} seats · ${report.ambiguous.length} ambiguous · ${report.warnings.length} warnings · ${report.unmatchedSeats.length} in the app but not in her list`);
  if (!DRY) console.log(`Ledger: ${LEDGER}`);
  const out = path.join(__dirname, "..", "backups", `import-shimrit-${DRY ? "dry" : "run"}.txt`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Object.entries(report).map(([k, lines]) => `## ${k}\n${lines.join("\n")}`).join("\n\n"));
  console.log(`Report: ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
