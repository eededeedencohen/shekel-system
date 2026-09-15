/**
 * @file retagEventCategories — re-file stored events into the finer
 * culture-event vocabulary of 2026-09-07 (theatre / concert / stand-up /
 * restaurant / museum … instead of the coarse show / outing / trip).
 *
 * Only events still carrying a PRE-SPLIT key are touched, and only when
 * the name makes the finer kind obvious (a "הצגה" is theatre, "מוסא" is a
 * restaurant, "מוזיאון" is a museum). Anything ambiguous keeps its key —
 * `show` is now the catch-all "מופע אחר", so nothing is ever invalid.
 * Idempotent: a second run finds nothing to do.
 *
 * Usage:  node scripts/retagEventCategories.js [--dry] [--world=test]
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Event = require("../models/Event");
const { EVENT_CATEGORY_KEYS, WORLDS } = require("../utils/domain");

/** Per pre-split key: ordered [pattern on the NAME, finer key]. */
const RULES = {
  show: [
    [/סטנדאפ|קוריאט/, "standup"],
    [/מחזמר/, "musical"],
    [/מחול|בלט|ריקוד/, "dance"],
    [/הצגה|תיאטרון/, "theatre"],
    [/קונצרט|הופעה|מופע מוזיקלי|ובנד|ג'יגליפאף/, "concert"],
    [/סרט|קולנוע/, "movie"],
  ],
  outing: [[/מסעד|מוסא|ארומה|קפה|ארוחת/, "restaurant"]],
  trip: [[/מוזיאון|תערוכה/, "museum"], [/פסטיבל/, "festival"]],
};

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyWorld = (args.find((a) => a.startsWith("--world=")) || "").slice(8) || null;

(async () => {
  await connectDB();
  for (const key of Object.values(RULES).flat().map(([, k]) => k)) {
    if (!EVENT_CATEGORY_KEYS.includes(key)) throw new Error(`unknown target category ${key}`);
  }
  const worlds = onlyWorld ? [onlyWorld] : WORLDS;
  let total = 0;
  for (const world of worlds) {
    const events = await Event.find({ world, category: { $in: Object.keys(RULES) } }).select("name category").lean();
    let n = 0;
    for (const ev of events) {
      const hit = RULES[ev.category].find(([re]) => re.test(ev.name));
      if (!hit) continue;
      const [, to] = hit;
      console.log(`  ${world} · ${ev.name}: ${ev.category} → ${to}`);
      if (!dry) await Event.updateOne({ _id: ev._id }, { $set: { category: to } });
      n++;
    }
    console.log(`${world}: ${events.length} pre-split events, ${n} ${dry ? "would be " : ""}re-filed`);
    total += n;
  }
  console.log(`${dry ? "[dry] " : ""}done — ${total} event(s)`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
