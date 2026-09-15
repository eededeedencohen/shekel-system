/**
 * @file seedPokemon — the isolated "עולם פוקימון" demo dataset
 * @module scripts/seedPokemon
 *
 * A complete parallel world the client can switch to (Topbar toggle →
 * X-Dataset header → the SERVER scopes every query by `world:"pokemon"`).
 * Real data is never touched: every document created here carries the
 * world tag and the purge is by that tag only. Fully re-runnable.
 *
 * What it creates:
 *   - 10 Subjects named after the 10 most common PRIMARY Pokémon types
 *     in the original 151 (מים, נורמלי, רעל, עשב, אש, חרקים, חשמל, סלע,
 *     אדמה, על-חושי) + the 4 course-less types as demand-only subjects.
 *   - 7 Rooms (the shared campus rooms of ליגת קאנטו).
 *   - 10 teachers, each the gym leader of their type, last name = the
 *     type (= the base course): ברוק סלע, מיסטי מים, סרג' חשמל, ...
 *   - ~45 course cycles in a deliberate MIX of shapes per type — private
 *     lesson (one Pokémon), pair, small group with seats, full group,
 *     open group, brand-new empty group, planned cycle — all classified
 *     for the desk, taught by the type's leader, and scheduled by a small
 *     solver into SHARED campus rooms (6 rooms + "חדר אישי" for privates)
 *     with varied durations/start times and no teacher or room clashes.
 *   - 151 students = the Pokémon (Hebrew first name, English last name),
 *     avatar = the Pokémon's picture (client/public/pokemon/<slug>.png),
 *     interest = their ONE primary type.
 *       136 belong to the 10 course types → spread across the pipeline:
 *         ~53% Placed (enrolled in a cycle of their type), ~20% Matching,
 *         the rest Interested / Intake / AwaitingPlacement / NeedsReplacement.
 *       15 have a primary type with NO course (לחימה/רוחות/דרקון/קרח) →
 *         all in Matching — their interest is natural demand for a new
 *         course.
 *
 * Usage:  node scripts/seedPokemon.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { Person } = require("../models/Person");
const { Profile } = require("../models/profiles");
const { createPersonWithProfile } = require("../services/profileService");
const Subject = require("../models/Subject");
const Cycle = require("../models/Cycle");
const Enrollment = require("../models/Enrollment");
const Lesson = require("../models/Lesson");
const Room = require("../models/Room");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Voucher = require("../models/Voucher");
const { seedCulture } = require("./lib/cultureSeed");

const WORLD = "pokemon";
const IMG_DIR = path.join(__dirname, "..", "..", "client", "public", "pokemon");
const DAY = 86400000;
const now = Date.now();
const bd = (age) => new Date(now - Math.round((age * 365.25 + 40) * DAY));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ────────────────────────── types ────────────────────────── */

const TYPE_HE = {
  Water: "מים",
  Normal: "נורמלי",
  Poison: "רעל",
  Grass: "עשב",
  Fire: "אש",
  Bug: "חרקים",
  Electric: "חשמל",
  Rock: "סלע",
  Ground: "אדמה",
  Psychic: "על-חושי",
  Fighting: "לחימה",
  Ghost: "רוחות",
  Dragon: "דרקון",
  Ice: "קרח",
};

/** The 10 types that get a base course (most common primary types). */
const COURSE_TYPES = [
  "Water", "Normal", "Poison", "Grass", "Fire",
  "Bug", "Electric", "Rock", "Ground", "Psychic",
];
/**
 * SHARED campus rooms (a real constraint, not one room per course):
 * several types compete for the same room, and the scheduler below makes
 * sure no two cycles overlap in a room. Private lessons all share the
 * small "חדר אישי".
 */
const ROOM_OF = {
  Water: "הבריכה",
  Grass: "החממה",
  Bug: "החממה",
  Electric: "המעבדה",
  Fire: "המעבדה",
  Poison: "המעבדה",
  Normal: "אולם הקרב",
  Psychic: "חדר המדיטציה",
  Rock: "מגרש הסלעים",
  Ground: "מגרש הסלעים",
};
const PRIVATE_ROOM = "חדר אישי";

/** Each leader's availability — deliberately different (mornings,
 *  afternoons, evenings, 2–3 days) so the week isn't one big 10:00. */
const TEACHER_WINDOWS = {
  Water: [[0, "08:00", "14:00"], [2, "09:00", "13:00"], [4, "14:00", "19:00"]],
  Normal: [[1, "09:00", "15:00"], [3, "09:00", "12:00"], [4, "08:00", "12:00"]],
  Poison: [[0, "13:00", "19:00"], [2, "13:00", "18:00"]],
  Grass: [[1, "08:00", "13:00"], [3, "14:00", "18:00"], [0, "09:00", "12:00"]],
  Fire: [[2, "15:00", "20:00"], [4, "15:00", "20:00"], [1, "16:00", "19:00"]],
  Bug: [[0, "09:00", "13:00"], [3, "09:00", "13:00"]],
  Electric: [[1, "12:00", "18:00"], [4, "09:00", "14:00"]],
  Rock: [[2, "08:00", "12:00"], [4, "12:00", "16:00"], [0, "15:00", "18:00"]],
  Ground: [[3, "12:00", "18:00"], [1, "13:00", "17:00"]],
  Psychic: [[0, "16:00", "20:00"], [2, "16:00", "20:00"], [4, "10:00", "13:00"]],
};

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const overlaps = (list, day, s, e) => list.some((b) => b.day === day && b.s < e && s < b.e);

/** Gym leader of each type = its teacher's first name. */
const LEADERS = {
  Rock: "ברוק",
  Water: "מיסטי",
  Electric: "סרג'",
  Grass: "אריקה",
  Poison: "קוגה",
  Psychic: "סברינה",
  Fire: "בליין",
  Ground: "ג'ובאני",
  Bug: "באגסי",
  Normal: "ויטני",
};

/* ────────────────────────── the 151 ──────────────────────────
 * [dex, image slug, Hebrew name, PRIMARY type (Gen 1 typing)]       */
const POKEMON = [
  [1, "bulbasaur", "בולבזאור", "Grass"],
  [2, "ivysaur", "איביזאור", "Grass"],
  [3, "venusaur", "ונוסאור", "Grass"],
  [4, "charmander", "צ'ארמנדר", "Fire"],
  [5, "charmeleon", "צ'ארמיליון", "Fire"],
  [6, "charizard", "צ'אריזארד", "Fire"],
  [7, "squirtle", "סקוורטל", "Water"],
  [8, "wartortle", "וורטורטל", "Water"],
  [9, "blastoise", "בלסטויז", "Water"],
  [10, "caterpie", "קטרפי", "Bug"],
  [11, "metapod", "מטאפוד", "Bug"],
  [12, "butterfree", "באטרפרי", "Bug"],
  [13, "weedle", "וידל", "Bug"],
  [14, "kakuna", "קאקונה", "Bug"],
  [15, "beedrill", "בידריל", "Bug"],
  [16, "pidgey", "פיג'י", "Normal"],
  [17, "pidgeotto", "פיג'וטו", "Normal"],
  [18, "pidgeot", "פיג'וט", "Normal"],
  [19, "rattata", "ראטאטה", "Normal"],
  [20, "raticate", "ראטיקייט", "Normal"],
  [21, "spearow", "ספירו", "Normal"],
  [22, "fearow", "פירו", "Normal"],
  [23, "ekans", "אקאנס", "Poison"],
  [24, "arbok", "ארבוק", "Poison"],
  [25, "pikachu", "פיקאצ'ו", "Electric"],
  [26, "raichu", "רייצ'ו", "Electric"],
  [27, "sandshrew", "סנדשרו", "Ground"],
  [28, "sandslash", "סנדסלאש", "Ground"],
  [29, "nidoran-f", "נידוראן ♀", "Poison"],
  [30, "nidorina", "נידורינה", "Poison"],
  [31, "nidoqueen", "נידוקווין", "Poison"],
  [32, "nidoran-m", "נידוראן ♂", "Poison"],
  [33, "nidorino", "נידורינו", "Poison"],
  [34, "nidoking", "נידוקינג", "Poison"],
  [35, "clefairy", "קלפיירי", "Normal"],
  [36, "clefable", "קלפייבל", "Normal"],
  [37, "vulpix", "וולפיקס", "Fire"],
  [38, "ninetales", "ניינטיילס", "Fire"],
  [39, "jigglypuff", "ג'יגליפאף", "Normal"],
  [40, "wigglytuff", "ויגליטאף", "Normal"],
  [41, "zubat", "זובאט", "Poison"],
  [42, "golbat", "גולבאט", "Poison"],
  [43, "oddish", "אודיש", "Grass"],
  [44, "gloom", "גלום", "Grass"],
  [45, "vileplume", "ויילפלום", "Grass"],
  [46, "paras", "פאראס", "Bug"],
  [47, "parasect", "פאראסקט", "Bug"],
  [48, "venonat", "ונונאט", "Bug"],
  [49, "venomoth", "ונומות'", "Bug"],
  [50, "diglett", "דיגלט", "Ground"],
  [51, "dugtrio", "דאגטריו", "Ground"],
  [52, "meowth", "מיאות'", "Normal"],
  [53, "persian", "פרשן", "Normal"],
  [54, "psyduck", "פסיידאק", "Water"],
  [55, "golduck", "גולדאק", "Water"],
  [56, "mankey", "מאנקי", "Fighting"],
  [57, "primeape", "פריימאייפ", "Fighting"],
  [58, "growlithe", "גרוליט'", "Fire"],
  [59, "arcanine", "ארקנין", "Fire"],
  [60, "poliwag", "פוליוואג", "Water"],
  [61, "poliwhirl", "פוליווירל", "Water"],
  [62, "poliwrath", "פוליראת'", "Water"],
  [63, "abra", "אברה", "Psychic"],
  [64, "kadabra", "קדברה", "Psychic"],
  [65, "alakazam", "אלאקאזאם", "Psychic"],
  [66, "machop", "מאצ'ופ", "Fighting"],
  [67, "machoke", "מאצ'וק", "Fighting"],
  [68, "machamp", "מאצ'אמפ", "Fighting"],
  [69, "bellsprout", "בלספראוט", "Grass"],
  [70, "weepinbell", "ויפינבל", "Grass"],
  [71, "victreebel", "ויקטריבל", "Grass"],
  [72, "tentacool", "טנטקול", "Water"],
  [73, "tentacruel", "טנטקרול", "Water"],
  [74, "geodude", "ג'אודוד", "Rock"],
  [75, "graveler", "גרבלר", "Rock"],
  [76, "golem", "גולם", "Rock"],
  [77, "ponyta", "פוניטה", "Fire"],
  [78, "rapidash", "ראפידאש", "Fire"],
  [79, "slowpoke", "סלופוק", "Water"],
  [80, "slowbro", "סלוברו", "Water"],
  [81, "magnemite", "מגנמייט", "Electric"],
  [82, "magneton", "מגנטון", "Electric"],
  [83, "farfetchd", "פארפצ'ד", "Normal"],
  [84, "doduo", "דודואו", "Normal"],
  [85, "dodrio", "דודריו", "Normal"],
  [86, "seel", "סיל", "Water"],
  [87, "dewgong", "דיוגונג", "Water"],
  [88, "grimer", "גריימר", "Poison"],
  [89, "muk", "מאק", "Poison"],
  [90, "shellder", "שלדר", "Water"],
  [91, "cloyster", "קלויסטר", "Water"],
  [92, "gastly", "גאסטלי", "Ghost"],
  [93, "haunter", "האונטר", "Ghost"],
  [94, "gengar", "גנגר", "Ghost"],
  [95, "onix", "אוניקס", "Rock"],
  [96, "drowzee", "דראוזי", "Psychic"],
  [97, "hypno", "היפנו", "Psychic"],
  [98, "krabby", "קראבי", "Water"],
  [99, "kingler", "קינגלר", "Water"],
  [100, "voltorb", "וולטורב", "Electric"],
  [101, "electrode", "אלקטרוד", "Electric"],
  [102, "exeggcute", "אקסגקיוט", "Grass"],
  [103, "exeggutor", "אקסגיוטור", "Grass"],
  [104, "cubone", "קיובון", "Ground"],
  [105, "marowak", "מארוואק", "Ground"],
  [106, "hitmonlee", "היטמונלי", "Fighting"],
  [107, "hitmonchan", "היטמונצ'אן", "Fighting"],
  [108, "lickitung", "ליקיטונג", "Normal"],
  [109, "koffing", "קופינג", "Poison"],
  [110, "weezing", "ויזינג", "Poison"],
  [111, "rhyhorn", "רייהורן", "Ground"],
  [112, "rhydon", "ריידון", "Ground"],
  [113, "chansey", "צ'אנסי", "Normal"],
  [114, "tangela", "טנגלה", "Grass"],
  [115, "kangaskhan", "קנגסקאן", "Normal"],
  [116, "horsea", "הורסי", "Water"],
  [117, "seadra", "סידרה", "Water"],
  [118, "goldeen", "גולדין", "Water"],
  [119, "seaking", "סיקינג", "Water"],
  [120, "staryu", "סטאריו", "Water"],
  [121, "starmie", "סטארמי", "Water"],
  [122, "mr-mime", "מר. מיים", "Psychic"],
  [123, "scyther", "סיית'ר", "Bug"],
  [124, "jynx", "ג'ינקס", "Ice"],
  [125, "electabuzz", "אלקטבאז", "Electric"],
  [126, "magmar", "מגמר", "Fire"],
  [127, "pinsir", "פינסר", "Bug"],
  [128, "tauros", "טאורוס", "Normal"],
  [129, "magikarp", "מג'יקארפ", "Water"],
  [130, "gyarados", "גיארדוס", "Water"],
  [131, "lapras", "לאפראס", "Water"],
  [132, "ditto", "דיטו", "Normal"],
  [133, "eevee", "איווי", "Normal"],
  [134, "vaporeon", "ואפוריאון", "Water"],
  [135, "jolteon", "ג'ולטיאון", "Electric"],
  [136, "flareon", "פלאריאון", "Fire"],
  [137, "porygon", "פוריגון", "Normal"],
  [138, "omanyte", "אומנייט", "Rock"],
  [139, "omastar", "אומסטאר", "Rock"],
  [140, "kabuto", "קבוטו", "Rock"],
  [141, "kabutops", "קבוטופס", "Rock"],
  [142, "aerodactyl", "אירודקטיל", "Rock"],
  [143, "snorlax", "סנורלקס", "Normal"],
  [144, "articuno", "ארטיקונו", "Ice"],
  [145, "zapdos", "זאפדוס", "Electric"],
  [146, "moltres", "מולטרס", "Fire"],
  [147, "dratini", "דראטיני", "Dragon"],
  [148, "dragonair", "דרגונאייר", "Dragon"],
  [149, "dragonite", "דרגונייט", "Dragon"],
  [150, "mewtwo", "מיוטו", "Psychic"],
  [151, "mew", "מיו", "Psychic"],
];

/* ────────────────────────── distribution ────────────────────────── */

/** Stage pattern cycled over each type's Pokémon (dex order):
 *  8/15 Placed · 3/15 Matching · 1 each Interested / Intake /
 *  AwaitingPlacement / NeedsReplacement. */
const STAGE_PATTERN = [
  "Placed", "Placed", "Matching", "Placed", "Interested",
  "Placed", "Matching", "AwaitingPlacement", "Placed", "NeedsReplacement",
  "Placed", "Intake", "Matching", "Placed", "Placed",
];

const STAGE_PATHS = {
  Interested: ["Interested"],
  Matching: ["Interested", "Matching"],
  Intake: ["Interested", "Matching", "Intake"],
  AwaitingPlacement: ["Interested", "Matching", "Intake", "AwaitingPlacement"],
  Placed: ["Interested", "Matching", "Intake", "AwaitingPlacement", "Placed"],
  NeedsReplacement: ["Placed", "NeedsReplacement"],
};
const MOVED_BY = ["פרופ' אוק", "האחות ג'וי", "השוטרת ג'ני"];
const TOWNS = [
  "פאלט", "וירידיאן", "פיוטר", "סרוליאן", "ורמיליון",
  "לבנדר", "סלדון", "פוקסיה", "סאפרון", "סינבר",
];
const LEVELS = ["High", "Medium", "Low"];

/** Deterministic availability: 3 days; morning / afternoon / evening by dex. */
function availabilityFor(dex) {
  const days = [dex % 5, (dex + 2) % 5, (dex + 3) % 5];
  const span = [["09:00", "13:00"], ["12:00", "16:00"], ["15:00", "19:00"]][dex % 3];
  return [...new Set(days)].map((day) => ({ day, start: span[0], end: span[1] }));
}

/* ────────────────────────── run ────────────────────────── */

(async () => {
  await connectDB();

  /* 1 ── purge the whole demo world (by `world` tag only) */
  const purged = {};
  for (const [name, Model] of Object.entries({
    lessons: Lesson,
    enrollments: Enrollment,
    cycles: Cycle,
    eventRegistrations: EventRegistration,
    events: Event,
    vouchers: Voucher,
    profiles: Profile,
    people: Person,
    subjects: Subject,
    rooms: Room,
  })) {
    purged[name] = (await Model.deleteMany({ world: WORLD })).deletedCount;
  }
  console.log(
    "Purged world:pokemon — " +
      Object.entries(purged).map(([k, v]) => `${k} ${v}`).join(" · ")
  );

  /* 2 ── subjects: one per type. The 10 taught types plus the 4 that have
   *      no course — those exist purely as demand ("צריך מורה"). */
  const subjectByType = {};
  for (const t of Object.keys(TYPE_HE)) {
    subjectByType[t] = await Subject.create({
      world: WORLD,
      name: TYPE_HE[t],
      category: "pokemon",
      active: true,
    });
  }
  console.log(
    `Subjects: ${Object.keys(TYPE_HE).length} ` +
      `(${COURSE_TYPES.length} עם קורס, ${Object.keys(TYPE_HE).length - COURSE_TYPES.length} ביקוש בלבד)`
  );

  /* 2b ── rooms: the shared campus rooms of the league */
  const roomNames = [...new Set([...Object.values(ROOM_OF), PRIVATE_ROOM])];
  const roomByName = {};
  for (const name of roomNames) {
    roomByName[name] = await Room.create({ world: WORLD, name, active: true });
  }
  console.log(`Rooms: ${roomNames.length} (${roomNames.join(", ")})`);

  /* 3 ── teachers: the gym leaders (last name = their type/subject) */
  const teacherByType = {};
  for (const t of COURSE_TYPES) {
    teacherByType[t] = (await createPersonWithProfile("Teacher", {
      world: WORLD,
      firstName: LEADERS[t],
      lastName: TYPE_HE[t],
      email: `pokemon_leader_${t.toLowerCase()}@pokedex.local`,
      phone: `054-${String(7000000 + COURSE_TYPES.indexOf(t) * 1111).slice(0, 7)}`,
      availability: TEACHER_WINDOWS[t].map(([day, start, end]) => ({ day, start, end })),
      subjects: [subjectByType[t]._id],
    })).person;
  }
  console.log(`Teachers: ${COURSE_TYPES.length} gym leaders`);

  /* 4 ── students: the 151 */
  const byType = {};
  for (const p of POKEMON) (byType[p[3]] ||= []).push(p);

  const studentUser = {}; // dex → Person
  const stageOf = {}; // dex → stage
  const counts = {};
  let missingImg = 0;

  for (const [type, list] of Object.entries(byType)) {
    const hasCourse = COURSE_TYPES.includes(type);
    list.forEach(([dex, slug, he], j) => {
      stageOf[dex] = hasCourse ? STAGE_PATTERN[j % STAGE_PATTERN.length] : "Matching";
    });
  }

  for (const [dex, slug, he, type] of POKEMON) {
    const img = path.join(IMG_DIR, `${slug}.png`);
    if (!fs.existsSync(img)) {
      missingImg++;
      console.warn(`⚠ missing image: ${slug}.png`);
    }
    const stage = stageOf[dex];
    const pathArr = STAGE_PATHS[stage];
    const firstMoveAgo = 60 - (dex % 40);
    const stepDays = Math.max(2, Math.floor(firstMoveAgo / pathArr.length));
    const stageHistory = pathArr.map((s, idx) => ({
      stage: s,
      movedBy: MOVED_BY[(dex + idx) % MOVED_BY.length],
      movedAt: new Date(now - (firstMoveAgo - idx * stepDays) * DAY),
      note: idx === pathArr.length - 1 && s === "Matching" ? `מחפש/ת מכון ${TYPE_HE[type]}` : "",
    }));
    const tail = stageHistory[stageHistory.length - 1];

    const needsProfile = ["Matching", "NeedsReplacement", "AwaitingPlacement"].includes(stage);
    const { person } = await createPersonWithProfile("StudentCollege", {
      world: WORLD,
      firstName: he,
      lastName: cap(slug.replace(/-f$/, "").replace(/-m$/, "").replace(/-/g, " ")),
      email: `pokemon_${slug.replace(/[^a-z]/g, "")}@pokedex.local`,
      phone: `055-${String(1000000 + dex * 6607).slice(0, 7)}`,
      birthDate: bd(18 + (dex % 28)),
      gender: dex % 2 ? "male" : "female",
      avatar: { style: "image", src: `/pokemon/${slug}.png` },
      // Availability is only declared by the students who are actively
      // being matched — exactly like the old world.
      availability: needsProfile ? availabilityFor(dex) : [],
      pipeline: { stage: tail.stage, since: tail.movedAt },
      stageHistory,
      matching: {
        functioningLevel: LEVELS[dex % 3],
        interests: [subjectByType[type]._id],
        ...(needsProfile && {
          groupPreference: dex % 7 === 0 ? "Private" : dex % 4 === 0 ? "Flexible" : "Group",
        }),
      },
      residence: { label: `עיר ${TOWNS[dex % TOWNS.length]}` },
      notes: `#${String(dex).padStart(3, "0")} · סוג ${TYPE_HE[type]}`,
      import: { registrationSource: "פוקדקס" },
    }, { trusted: true });
    studentUser[dex] = person;
    counts[stage] = (counts[stage] || 0) + 1;
  }
  console.log(`Students: ${POKEMON.length}` + (missingImg ? ` (⚠ ${missingImg} תמונות חסרות)` : " — כל התמונות נמצאו"));

  /* 5 ── course cycles: a MIX of shapes per type (not "cram everyone in")
   *      — private lesson (one Pokémon), pair, small group with seats,
   *      full group, open group, brand-new empty group, planned cycle.
   *      The Placed students are dealt into the shapes in order; the
   *      template is rotated per type so no two types look alike.       */
  const startDate = new Date(now - 45 * DAY);
  const endDate = new Date(now + 320 * DAY);
  // Time-of-day label from the scheduled start (day-letter tokens like
  // "א׳" would be stripped by the client's course-name cleaner).
  const dayPart = (m) => (m < 12 * 60 ? "בוקר" : m < 15 * 60 ? "צהריים" : "ערב");
  const KINDS = {
    private: { label: "שיעור פרטני", capacity: 1, take: 1, format: "Private", minutes: 45 },
    pair: { label: "זוג", capacity: 2, take: 2, format: "Group", minutes: 60 },
    small: { label: "קבוצה קטנה", capacity: 4, take: 3, format: "Group", minutes: 90 },
    full: { label: null, capacity: 6, take: 6, format: "Group", minutes: 90 }, // "קבוצת <בוקר/…>"
    open: { label: null, capacity: 8, take: 4, format: "Group", minutes: 120 },
    empty: { label: "קבוצה חדשה", capacity: 6, take: 0, format: "Group", minutes: 90 },
    planned: { label: "מחזור מתוכנן", capacity: 8, take: 0, format: "Group", status: "Planned", minutes: 0 },
  };

  // Scheduler: first free (day, start) inside the teacher's windows where
  // neither the teacher nor the room is busy. Windows are tried in a
  // rotated order per cycle; lessons get a 15-min buffer between them.
  const teacherBusy = {};
  const roomBusy = {};
  const schedule = (t, room, minutes, k) => {
    const wins = TEACHER_WINDOWS[t];
    teacherBusy[t] ||= [];
    roomBusy[room] ||= [];
    for (let w = 0; w < wins.length; w++) {
      const [day, from, to] = wins[(k + w) % wins.length];
      for (let s = toMin(from); s + minutes <= toMin(to); s += 15) {
        const e = s + minutes;
        if (overlaps(teacherBusy[t], day, s, e)) continue;
        if (overlaps(roomBusy[room], day, s, e)) continue;
        teacherBusy[t].push({ day, s, e: e + 15 });
        roomBusy[room].push({ day, s, e: e + 15 });
        return { day, start: fmt(s), end: fmt(e), startMin: s };
      }
    }
    throw new Error(`no free slot for ${t} cycle ${k} in ${room}`);
  };
  const TEMPLATE = ["full", "private", "open", "pair", "small", "private"];
  const TAIL = ["empty", "planned", "empty", null]; // extra zero-enrolment cycle, by type
  const shapeSummary = [];
  let cycleCount = 0;
  let enrollCount = 0;

  for (const [ti, t] of COURSE_TYPES.entries()) {
    const rest = byType[t].filter(([dex]) => stageOf[dex] === "Placed");
    // No single cycle swallows more than a third of the type's placed
    // students → every type ends up with at least ~3 different shapes.
    const takeCap = Math.max(1, Math.ceil(rest.length / 3));
    const plan = [];
    let i = ti; // rotate the template per type for variety
    while (rest.length) {
      const kind = TEMPLATE[i++ % TEMPLATE.length];
      const take = Math.min(KINDS[kind].take, takeCap, rest.length);
      plan.push({ kind, students: rest.splice(0, take) });
    }
    const tail = TAIL[ti % TAIL.length];
    if (tail) plan.push({ kind: tail, students: [] });

    const cycles = [];
    for (const [k, { kind, students }] of plan.entries()) {
      const K = KINDS[kind];
      const room = kind === "private" ? PRIVATE_ROOM : ROOM_OF[t];
      const slot =
        K.status === "Planned" ? null : schedule(t, room, K.minutes, k);
      const part = slot ? dayPart(slot.startMin) : "";
      const n = students.length;
      // "full" is genuinely full even when fewer students were left.
      const capacity = kind === "full" ? Math.max(1, n) : K.capacity;
      const label = K.label
        ? part ? `${K.label} · ${part}` : K.label
        : `קבוצת ${part}`;

      const cycle = await Cycle.create({
        world: WORLD,
        subject: subjectByType[t]._id,
        teacher: teacherByType[t]._id,
        status: K.status || "Active",
        startDate: K.status === "Planned" ? new Date(now + 30 * DAY) : startDate,
        endDate,
        schedule: slot
          ? [
              {
                day: slot.day,
                start: slot.start,
                end: slot.end,
                room: roomByName[room]._id,
              },
            ]
          : [],
        matching: {
          capacity,
          ageMin: 18,
          ageMax: 60,
          functioningLevels:
            kind === "private" ? LEVELS : k % 3 === 0 ? LEVELS : k % 3 === 1 ? ["High", "Medium"] : ["Medium", "Low"],
          format: K.format,
          enrollmentOpen: true,
          requirements: kind === "private" ? "מפגש אישי עם המנהיג/ה" : "",
          requiredRooms: [roomByName[room]._id],
        },
        import: { senzeyName: `${TYPE_HE[t]} — ${label}` },
      });
      // Membership is its own collection now — one record per student.
      for (const [j, [dex]] of students.entries()) {
        await Enrollment.create({
          world: WORLD,
          cycle: cycle._id,
          student: studentUser[dex]._id,
          status: "active",
          slotId: cycle.schedule[0]?._id || null,
          joinedAt: new Date(now - (40 - j * 2) * DAY),
        });
        enrollCount++;
      }
      cycles.push({ ci: cycle, kind, n, capacity, room, slot });
      cycleCount++;
    }
    const DAYS_HE = ["א", "ב", "ג", "ד", "ה", "ו"];
    shapeSummary.push(
      `   ${TYPE_HE[t]}: ` +
        cycles
          .map(
            (c) =>
              `${KINDS[c.kind].label || "קבוצה"} ${c.n}/${c.capacity}` +
              (c.slot ? ` [${DAYS_HE[c.slot.day]}׳ ${c.slot.start}–${c.slot.end} @${c.room}]` : " [מתוכנן]")
          )
          .join(" · ")
    );
  }
  console.log(`Course cycles: ${cycleCount} · enrollments: ${enrollCount}`);
  shapeSummary.forEach((l) => console.log(l));

  /* 5b ── תרבות לכל: no new humans (all 151 Pokémon exist) — a few join
   *       culture in ADDITION to the league, a dozen TRANSFER to it (their
   *       league seats are given back with the reason), one transfers back. */
  let seedA = 151;
  const rnd = () => {
    seedA |= 0;
    seedA = (seedA + 0x6d2b79f5) | 0;
    let t = Math.imul(seedA ^ (seedA >>> 15), 1 | seedA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const enrolledDex = new Set();
  for (const e of await Enrollment.find({ world: WORLD, status: "active" }).select("student").lean()) {
    enrolledDex.add(String(e.student));
  }
  await seedCulture({
    world: WORLD,
    rnd,
    collegeStudents: POKEMON.map(([dex]) => ({
      person: studentUser[dex],
      stage: stageOf[dex],
      enrolled: enrolledDex.has(String(studentUser[dex]._id)) ? [1] : [],
    })),
    counts: { cultureOnlyNew: 0, both: 6, transfersToCulture: 12, transfersToCollege: 1, pastEvents: 7, upcomingEvents: 6, drafts: 2, vouchers: 12 },
    flavour: {
      lastName: "",
      emailPrefix: "pokemon",
      emailDomain: "pokedex.local",
      systemActor: "פרופ' אוק",
      staff: [
        { firstName: "פרופ' אלם", lastName: "ניו בארק", title: "מנהל תרבות לכל" },
        { firstName: "לורלי", lastName: "אליט פור", title: "רכזת אירועים" },
      ],
      studentFirstNames: [],
      transferNotes: {
        toCulture: ["העדיף/ה טורנירים על פני אימונים שבועיים במכון", "המאמן/ת ביקש/ה פחות מחויבות שבועית"],
        toCollege: ["רוצה להתאמן במכון קבוע לקראת הליגה"],
      },
      cancelReasons: ["נפצע/ה בקרב", "הוחלף/ה בקבוצה", "לא נמצאה הסעה מהעיר"],
      eventCancelReasons: ["טים רוקט השתלט על האולם", "סופת ברקים — הטורניר נדחה"],
      attendanceNotes: {
        present: ["הגיע/ה עם המאמן/ת", "ניצח/ה בסיבוב הראשון"],
        absent: ["הודיע/ה מראש", "נשאר/ה במרכז הפוקימון"],
      },
      voucherNotes: ["ניצחון בטורניר", "אימון מצטיין", "מתנת פרופ' אוק"],
      voucherPlaces: [
        { name: "פוקי-מארט", prefix: "PKM", note: "תקף בכל הסניפים בקאנטו" },
        { name: "מרכז הפוקימון", prefix: "PKC" },
        { name: "מספרת סלדון", prefix: "SLD" },
        { name: "קפה וירידיאן", prefix: "VRD" },
      ],
      events: [
        { name: "טורניר במכון פיוטר", category: "sport", location: "מכון פיוטר", capacity: 16, hour: 17, endTime: "20:00" },
        { name: "טיול ליער וירידיאן", category: "trip", location: "יער וירידיאן", capacity: 14, hour: 8, endTime: "16:00" },
        { name: "מופע ג'יגליפאף", category: "concert", location: "אולם סלדון", capacity: 20, hour: 19, endTime: "21:00" },
        { name: "סדנת פוקי-בול", category: "workshop", location: "מעבדת פרופ' אוק", capacity: 8, hour: 16, endTime: "18:00" },
        { name: "הרצאה: אבולוציה בטבע", category: "lecture", location: "מוזיאון פיוטר", capacity: 25, hour: 18, endTime: "19:30" },
        { name: "מסיבת יום הפוקימון", category: "party", location: "מרכז הפוקימון", capacity: 40, hour: 19, endTime: "22:00" },
        { name: "שייט לאי סינבר", category: "trip", location: "נמל ורמיליון", capacity: 12, hour: 9, endTime: "17:00", ageMin: 21 },
        { name: "ליגת הנשים — ערב סיסטר", category: "party", location: "מכון סרוליאן", capacity: 12, gender: "women", hour: 18, endTime: "21:00" },
        { name: "מרוץ רפידאש", category: "sport", location: "כביש 7", capacity: 10, gender: "men", hour: 7, endTime: "09:00" },
        { name: "התנדבות במרכז הפוקימון", category: "volunteering", location: "מרכז הפוקימון", capacity: 10, hour: 10, endTime: "13:00" },
        { name: "קונצרט מיסטי ובנד", category: "concert", location: "מכון סרוליאן", capacity: 18, hour: 20, endTime: "22:00" },
        { name: "סדנת בישול אוכל פוקימון", category: "workshop", location: "מטבח ברוק", capacity: 8, hour: 17, endTime: "19:00" },
        { name: "טיול להר הירח", category: "trip", location: "הר הירח", capacity: 15, hour: 8, endTime: "18:00", ageMax: 40 },
        { name: "ערב סרט: פוקימון הסרט", category: "movie", location: "קולנוע סלדון", capacity: 30, hour: 20, endTime: "22:00" },
        { name: "מסיבת סוף הליגה", category: "party", location: "מישור האינדיגו", capacity: 60, hour: 19, endTime: "23:00" },
        { name: "סדנת אמנות — ציור פוקימונים", category: "workshop", location: "סטודיו סלדון", capacity: 10, hour: 16, endTime: "18:00" },
      ],
    },
  });

  /* 6 ── summary */
  console.log(`\n✅ עולם פוקימון מוכן:`);
  for (const [s, c] of Object.entries(counts)) console.log(`   ${s}: ${c}`);
  const noCourse = POKEMON.filter((p) => !COURSE_TYPES.includes(p[3]));
  console.log(
    `   ${noCourse.length} פוקימונים מסוגים בלי קורס (${[...new Set(noCourse.map((p) => TYPE_HE[p[3]]))].join(", ")}) → ביקוש לקורס חדש, חסר מורה`
  );

  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
