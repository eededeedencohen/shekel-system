/**
 * @file activitySeed - a person's record (לשונית פעילויות) in the test world
 * @module scripts/lib/activitySeed
 *
 * Gives the social worker's round (2026-10-07) something to look at:
 *   · follow-up calls at every distance - one due now, one overdue, one
 *     fresh - so the dashboard's "שיחת מעקב" group shows every state;
 *   · an evaluation that is due (a committee date two years back);
 *   · a hospitalisation, general updates, a first call;
 *   · one incident report (mirrored on the record), one without a manager told;
 *   · a closure report + leave report on someone who left;
 *   · one changed template (the follow-up's questions), so the editor shows
 *     a stored one beside the defaults.
 * Everything goes through the real services. Deterministic.
 */

const Intake = require("../../models/Intake");
const activities = require("../../services/activityService");
const incidents = require("../../services/incidentService");

const DAY = 86400000;
const daysAgo = (n, hour = 11) => {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/**
 * @param {object}   o
 * @param {string}   o.world
 * @param {object[]} o.placed    people placed in the college (at least 6)
 * @param {object[]} o.intakeDone people whose intake completed (any number)
 * @param {Function} [o.log]
 */
async function seedActivities({ world, placed, intakeDone = [], log = () => {} }) {
  const by = "נעה";
  const [a, b, c, d, e, f] = placed;
  let n = 0;
  const add = async (person, kind, at, body, fields, extra = {}) => {
    n++;
    return activities.addActivity({ world, person: person._id, kind, at, by: extra.by || by, body, fields, program: extra.program, skipRequired: true });
  };

  /* a · follow-ups at every distance */
  if (a) {
    await add(a, "followUp", daysAgo(100), "מגיע בקביעות, נהנה מהקורס. ביקש להצטרף גם לקורס ציור.", { attendance: "סדירה", motivation: "גבוהה", impression: "מצב רוח טוב, מחובר לקבוצה", next: "לבדוק מקום בציור" });
  }
  if (b) {
    await add(b, "followUp", daysAgo(200), "שיחה בטלפון. מגיעה חלקית בגלל עבודה חדשה.", { attendance: "חלקית", motivation: "בינונית", impression: "עייפה אבל רוצה להמשיך", next: "לבדוק אם אפשר לעבור לקבוצת ערב" });
    await add(b, "update", daysAgo(150), "דיברתי עם מתאמת הטיפול - מסכימה למעבר לערב.", {});
  }
  if (c) {
    await add(c, "followUp", daysAgo(10), "שיחה קצרה אחרי השיעור. הכל טוב.", { attendance: "סדירה", motivation: "גבוהה", impression: "מרוצה", next: "" });
    await add(c, "hospitalization", daysAgo(40), "אשפוז קצר במחלקה הפסיכיאטרית בהדסה. חזר לקורסים אחרי שבועיים.", { where: "הדסה עין כרם", from: daysAgo(45), to: daysAgo(31), contact: "אחות אחראית - 02-6777111" });
  }
  if (d) {
    // a committee date two years back → the evaluation is due now
    const rec = await Intake.findOne({ world, person: d._id });
    if (rec) {
      rec.committeeDate = daysAgo(740);
      await rec.save();
    } else {
      await Intake.create({ world, person: d._id, source: "staff", committeeDate: daysAgo(740), log: [{ action: "committee", by, note: "תאריך ועדת שיקום (נתוני טסט)" }] });
    }
    await add(d, "evaluation", daysAgo(735), "הערכה ראשונה אחרי הוועדה. מטרות: קביעות בקורס, חברים חדשים.", { progress: "התחלה טובה", occupational: "מחפש עבודה נתמכת", goals: "להתמיד בקורס מוזיקה; לפתוח קשרים חברתיים", shkediaUpdate: false });
    await add(d, "followUp", daysAgo(70), "מתמיד. דיבר על רצון לעבוד.", { attendance: "סדירה", motivation: "גבוהה", impression: "התקדמות יפה", next: "להפנות לתעסוקה נתמכת" });
  }

  /* e · an incident, reported to a manager; f · one not yet */
  if (e) {
    await incidents.reportIncident({
      world, person: e._id, at: daysAgo(6, 10),
      reportedBy: { name: "אביב טסט", role: "מורה" },
      primary: "violence", secondary: "אלימות מילולית",
      description: "במהלך שיעור בישול צעק על סטודנטית אחרת ויצא מהכיתה. חזר אחרי עשר דקות ונרגע.",
      actions: "המורה דיברה איתו בחוץ; המשיך בשיעור. דווח לנעה באותו יום.",
      managerNotified: { name: "נעה", at: daysAgo(6, 12) },
      by: "אביב טסט",
    });
    n++;
  }
  if (f) {
    await incidents.reportIncident({
      world, person: f._id, at: daysAgo(1, 16),
      reportedBy: { name: "רוני טסט", role: "מורה" },
      primary: "medical", secondary: "התקף",
      description: "התעלפה לרגע בסוף שיעור יוגה. התאוששה תוך דקה, שתתה מים. סירבה לאמבולנס.",
      actions: "הושבה, הוזעק מד\"א בטלפון להתייעצות, ההורים עודכנו.",
      by: "רוני טסט",
    });
    n++;
  }

  /* someone who finished the intake: a first call on the record */
  for (const p of intakeDone.slice(0, 2)) {
    await add(p, "update", daysAgo(3), "התקשרתי לוודא שהגיע/ה לשיעור הראשון - הכל בסדר.", {}, { by: "ייטב" });
  }

  /* the follow-up template, changed by the staff */
  await activities.saveTemplate({
    world,
    kind: "followUp",
    title: "שיחת מעקב רבעונית",
    body: "איך הולך בקורסים?\nמה טוב השבוע?\nמשהו שקשה?\nצריך/ה משהו מאיתנו?",
    fields: [
      { key: "attendance", label: "נוכחות", type: "select", options: ["סדירה", "חלקית", "לא מגיע/ה"], required: true },
      { key: "motivation", label: "מוטיבציה", type: "select", options: ["גבוהה", "בינונית", "נמוכה"] },
      { key: "impression", label: "התרשמות", type: "textarea", required: true },
      { key: "next", label: "יעדים לפעם הבאה", type: "textarea" },
      { key: "callFamily", label: "לעדכן את המשפחה", type: "checkbox" },
    ],
    by,
  });

  log(`Activities demo: ${n} rows (follow-ups, an evaluation, a hospitalisation, two incidents) · the follow-up template is the world's own`);
  return { count: n };
}

module.exports = { seedActivities };
