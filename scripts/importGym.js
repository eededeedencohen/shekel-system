/**
 * @file importGym - the old gym app's data into the system (one time)
 *
 * Eden (2026-10-29): the gym app (C:\2026\shekel\Projects\Gym, its own
 * database) moves into שק״ל. This reads the old database through the old
 * app's own config (Gym/server/config.env) and writes here:
 *   students  → a person each: an EXISTING person when exactly one student
 *               shares the phone digits (then: exactly one shares the full
 *               name - reported as "by name"), else a new person made like
 *               a new resident (person + bare student profile + the
 *               student tag); the `gym` tag; one GymMembership with the old
 *               statuses (interested / active / finished / notInterested)
 *               and the old invite token;
 *   gyms      → the membership's contract: the name as signed, the ID
 *               number, the phone, the signing date (the row's own time);
 *   images    → the signature PNG (<memberID>.png) to the bucket under
 *               gym/<membership>/signature.png.
 * A student already imported (source.gymStudentId) is skipped, so a
 * second run writes nothing twice. Ledger: server/backups/gym-import-<date>/.
 *
 *   node scripts/importGym.js --dry    # the plan, writes nothing
 *   node scripts/importGym.js          # writes
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");
const GymMembership = require("../models/GymMembership");
const tags = require("../services/tagService");
const storage = require("../services/storage");
const { normalizeIsraeliId } = require("../utils/israeliId");

const DRY = process.argv.includes("--dry");
const BY = "ייבוא מאפליקציית חדר הכושר";
const OLD_ENV = "C:/2026/shekel/Projects/Gym/server/config.env";
const STUDENT_KINDS = ["StudentCollege", "StudentCulture"];
const MEMBERSHIP = { interested: "interested", active: "active", finished: "finished", not_interested: "notInterested" };

const digits = (s) => String(s || "").replace(/\D/g, "");
const last9 = (s) => digits(s).slice(-9);
const collapse = (s) => String(s || "").trim().replace(/\s+/g, " ");
const prettyPhone = (p) => {
  const d = digits(p);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return String(p || "").trim();
};
const idTime = (id) => new Date(parseInt(String(id).slice(0, 8), 16) * 1000);

function oldUri() {
  const text = fs.readFileSync(OLD_ENV, "utf8");
  const get = (k) => (text.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return get("DATABASE").replace("<PASSWORD>", get("DATABASE_PASSWORD"));
}

(async () => {
  await connectDB();
  const old = await mongoose.createConnection(oldUri()).asPromise();
  const odb = old.db;
  const [students, gyms, images] = await Promise.all([
    odb.collection("students").find({}).sort({ createdAt: 1 }).toArray(),
    odb.collection("gyms").find({}).toArray(),
    odb.collection("images").find({}).toArray(),
  ]);
  const gymById = new Map(gyms.map((g) => [String(g._id), g]));
  const imageByName = new Map(images.map((i) => [i.filename, i]));
  console.log(`${DRY ? "[dry] " : ""}${students.length} students, ${gyms.length} contracts, ${images.length} signatures in the old database`);

  // the people a student may be: anyone with a student profile, by phone digits and by full name
  const studentIds = await Profile.distinct("person", { kind: { $in: STUDENT_KINDS } });
  const people = await Person.find({ _id: { $in: studentIds }, deletedAt: null }).select("firstName lastName phone gender").lean();
  const byPhone = new Map();
  const byName = new Map();
  for (const p of people) {
    const ph = last9(p.phone);
    if (ph.length >= 9) byPhone.set(ph, [...(byPhone.get(ph) || []), p]);
    const nm = collapse(`${p.firstName || ""} ${p.lastName || ""}`);
    if (nm) byName.set(nm, [...(byName.get(nm) || []), p]);
  }
  const done = new Set((await GymMembership.find({ "source.gymStudentId": { $ne: "" } }).select("source.gymStudentId").lean()).map((m) => m.source.gymStudentId));

  const dir = path.join(__dirname, "..", "backups", `gym-import-${new Date().toISOString().slice(0, 10)}`);
  const ledger = [];
  const report = { skipped: 0, matchedByPhone: 0, matchedByName: 0, created: 0, contracts: 0, signatures: 0, review: [] };

  for (const s of students) {
    const sid = String(s._id);
    const fullName = collapse(`${s.firstName || ""} ${s.lastName || ""}`);
    if (done.has(sid)) {
      report.skipped += 1;
      console.log(`  skip ${fullName} (already imported)`);
      continue;
    }
    const gym = s.contractID ? gymById.get(String(s.contractID)) : null;
    const image = gym ? imageByName.get(`${gym.memberID}.png`) : null;
    // the match
    let person = null;
    let how = "new";
    const ph = last9(s.phone);
    const phoneHits = ph.length >= 9 ? byPhone.get(ph) || [] : [];
    const nameHits = byName.get(fullName) || [];
    if (phoneHits.length === 1) {
      person = phoneHits[0];
      how = "phone";
      report.matchedByPhone += 1;
    } else if (phoneHits.length > 1) {
      report.review.push(`${fullName}: ${phoneHits.length} people share the phone - a new person was made`);
    } else if (nameHits.length === 1) {
      person = nameHits[0];
      how = "name";
      report.matchedByName += 1;
      report.review.push(`${fullName}: matched by name alone (phone ${s.phone || "-"} vs ${person.phone || "-"})`);
    } else if (nameHits.length > 1) {
      report.review.push(`${fullName}: ${nameHits.length} people share the name - a new person was made`);
    }
    const membership = s.statuses.map((k) => MEMBERSHIP[k]).find(Boolean) || null;
    const signedAt = gym ? gym.createdAt || idTime(gym._id) : null;
    const bytesOf = (d) => (!d ? 0 : Buffer.isBuffer(d) ? d.length : typeof d.length === "function" ? d.length() : d.buffer?.length || 0);
    console.log(`  ${fullName} · ${s.phone || "-"} · ${how === "new" ? "NEW person" : `= ${person.firstName} ${person.lastName} (by ${how})`} · ${membership || "no membership"} · ${gym ? `contract ${gym.memberID} ${signedAt.toISOString().slice(0, 10)}` : "no contract"} · ${image ? `${bytesOf(image.data)} B signature` : "no signature"}`);
    if (DRY) continue;

    if (!person) {
      const made = await Person.create({ firstName: s.firstName || "ללא שם", lastName: s.lastName || "", ...(["male", "female"].includes(s.gender) && { gender: s.gender }), ...(s.phone && { phone: prettyPhone(s.phone) }) });
      const profile = new MODEL_BY_KIND.StudentCollege({ person: made._id });
      profile.$locals.openedBy = BY;
      await profile.save();
      await tags.give({ personId: made._id, key: "student", by: BY });
      person = made;
      report.created += 1;
    } else if (!person.phone && s.phone) {
      await Person.updateOne({ _id: person._id }, { phone: prettyPhone(s.phone) });
    }
    await tags.give({ personId: person._id, key: "gym", by: BY, note: "חדר כושר" });
    let row = await GymMembership.findOne({ person: person._id });
    if (!row) row = new GymMembership({ person: person._id, inviteToken: s.inviteToken || undefined, log: [] });
    row.membership = membership;
    row.membershipChangedAt = membership ? s.updatedAt || null : null;
    row.linkSentAt = s.statuses.includes("form_sent") ? s.updatedAt || s.createdAt : row.linkSentAt;
    row.endedAt = null;
    row.source = { gymStudentId: sid, gymContractId: gym ? String(gym._id) : "" };
    row.log.push({ action: "imported", at: new Date(), by: BY, note: `מהאפליקציה הישנה (${s.statuses.join(", ")})` });
    if (gym) {
      await row.save(); // the id for the signature's key
      let signatureKey = "";
      if (image && image.data) {
        const bytes = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data.buffer || image.data);
        signatureKey = `gym/${row._id}/signature.png`;
        await storage.putBuffer({ key: signatureKey, body: bytes, mime: image.contentType || "image/png" });
        report.signatures += 1;
      }
      row.contract = { signedAt, name: collapse(gym.memberName) || fullName, idNumber: normalizeIsraeliId(gym.memberID) || String(gym.memberID), phone: prettyPhone(gym.phone || s.phone), signatureKey };
      report.contracts += 1;
    }
    await row.save();
    ledger.push({ gymStudentId: sid, name: fullName, how, person: String(person._id), membership: String(row._id), contract: gym ? String(gym._id) : null, signature: Boolean(image) });
  }

  if (!DRY) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ at: new Date(), report, ledger }, null, 2));
    console.log(`ledger ${path.join(dir, "ledger.json")}`);
  }
  console.log(`\n${DRY ? "[dry] " : ""}matched by phone ${report.matchedByPhone} · by name ${report.matchedByName} · new people ${report.created} · contracts ${report.contracts} · signatures ${report.signatures} · skipped ${report.skipped}`);
  if (report.review.length) console.log("to look at:\n  - " + report.review.join("\n  - "));
  await old.close();
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
