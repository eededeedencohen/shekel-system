/**
 * @file The staff's "service recipients" workbook beside the old system - a picture for the ideas page
 * @module services/recipientsService
 *
 * Eden (2026-11-25): "בעמוד הרעיונות אני רוצה טאב חדש - זה השוואות בין האקסל
 * שאני עכשיו אתן לך לבין סנזיי (שים לב - לא המערכת). תעשה לי הצלבה שיהיה לי
 * נוח… אל תתייחס לטאב של סיום התקשרות".
 *
 * The workbook has a sheet per program (תרבות לכל, מכללה לכל, הוסטלים, the
 * two branches, the people whose place is unclear), a line per person: a
 * name, the status, a frame, an ID number, a mobile, a note. It is kept
 * here as ONE settings row ("recipients"), behind the super admin's door,
 * exactly as the old system's own lists are kept (services/tagPlanService):
 * real people, never in the code - and their ID numbers and phones never
 * leave this file. Nothing of OUR people is read or changed: the two sides
 * of this picture are the workbook and the old system's lists.
 *
 * READ BACK, every line of a sheet says whom it is in the old system:
 *   in its ACTIVE students list, failing that in its POTENTIAL list - by the
 *   same ID number, the same phone with a name that agrees, or the same name
 *   (utils/nameCross) - or only LIKELY so (a name a letter away…), or nobody;
 *   and whether the old system's status speaks of the same program as the
 *   sheet the line stands in (`sameGroup`).
 * And the other way: who the old system's active list puts in a program and
 * the program's sheet does not hold (`senzeyOnly`).
 */

const AppSetting = require("../models/AppSetting");
const AppError = require("../utils/AppError");
const { normalizeIsraeliId, isValidIsraeliId } = require("../utils/israeliId");
const { crossCheck, nameKey } = require("../utils/nameCross");

const KEY = "recipients";
const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Which program a sheet's name, or a status, speaks of. "" = none of the ones the workbook is cut by. */
const GROUPS = [
  { key: "live", label: "מכללייב", re: /מי?כללייב/ },
  { key: "college", label: "מכללה לכל", re: /מכללה לכל/ },
  { key: "culture", label: "תרבות לכל", re: /תרבות לכל/ },
  { key: "maale", label: "מעלה אדומים", re: /מעלה אדומים/ },
  { key: "east", label: "מזרח ירושלים", re: /מגזר ערבי|מזרח ירושלים/ },
  { key: "hostels", label: "הוסטלים", re: /הוסטל/ },
  { key: "lost", label: "בירור / אבודים", re: /בירור|אבוד/ },
];
const groupOf = (s) => GROUPS.find((g) => g.re.test(String(s || "")))?.key || "";

/** One line of a sheet as it is kept. */
function sheetRow(r) {
  if (!isMap(r) || !text(r.name, 120)) throw AppError.of("TAG_PLAN_INVALID", 400);
  const digits = String(r.idNumber ?? "").replace(/\D/g, "");
  return {
    name: text(r.name, 120),
    idNumber: normalizeIsraeliId(digits),
    // an ID that was typed and is not one (too long, or the check digit fails) - said to the page as a fact, without the number
    idBad: Boolean(digits) && !isValidIsraeliId(digits),
    phone: text(r.phone, 30),
    status: text(r.status, 80),
    frame: text(r.frame, 120),
    course: text(r.course, 120),
    residence: text(r.residence, 60),
    mark: text(r.mark, 20),
    note: text(r.note, 500),
    red: Boolean(r.red),
  };
}

/** PUT - the whole workbook, replacing what was there: { source, takenAt, tabs: [{ name, rows: [...] }] }. */
async function set(body, by = "") {
  if (!isMap(body) || !Array.isArray(body.tabs) || !body.tabs.length || body.tabs.length > 20) throw AppError.of("TAG_PLAN_INVALID", 400);
  const tabs = body.tabs.map((t) => {
    if (!isMap(t) || !text(t.name, 60) || !Array.isArray(t.rows) || t.rows.length > 2000) throw AppError.of("TAG_PLAN_INVALID", 400);
    return { name: text(t.name, 60), rows: t.rows.map(sheetRow) };
  });
  const takenAt = body.takenAt && !Number.isNaN(new Date(body.takenAt).getTime()) ? new Date(body.takenAt).toISOString() : null;
  await AppSetting.findOneAndUpdate({ key: KEY }, { $set: { value: { source: text(body.source, 160), takenAt, tabs }, updatedBy: by } }, { upsert: true });
  return get();
}

async function clear() {
  await AppSetting.deleteOne({ key: KEY });
  return null;
}

const oldRows = async (key) => (await AppSetting.findOne({ key }).lean())?.value?.rows || [];
/** What a line of the old system says, as the page shows it (no number). */
const oldOut = (r, list) => ({ list, rid: String(r.rid), name: r.name, status: r.status || "", type: r.type || "", residence: r.residence || "", frame: r.frame || "", group: groupOf(r.status) });

/**
 * The workbook beside the old system, or null when none was loaded:
 *   { source, takenAt, loadedAt, loadedBy, senzey: { students, potential },
 *     tabs: [{ name, group, label, rows: [line], senzeyOnly: [old line + inTabs] }],
 *     others: [old line + inTabs]  - the active list's people whose status is none of the sheets' programs }
 *   line = { n, name, status, frame, course, residence, mark, note, red, hasId, idBad, hasPhone, also: [other sheets],
 *            match: null | { ...old line, sure, how | why, sameGroup } }
 */
async function get() {
  const kept = await AppSetting.findOne({ key: KEY }).lean();
  if (!kept || !isMap(kept.value) || !Array.isArray(kept.value.tabs)) return null;
  const [students, potential] = await Promise.all([oldRows("oldStudents"), oldRows("oldPotential")]);
  const sides = [
    { list: "students", rows: students, pre: "a" },
    { list: "potential", rows: potential, pre: "p" },
  ].map((s) => ({
    ...s,
    people: s.rows.map((r) => ({ _id: `${s.pre}${r.rid}`, name: r.name, phone: r.phone })),
    byNumber: new Map(s.rows.filter((r) => r.idNumber).map((r) => [r.idNumber, `${s.pre}${r.rid}`])),
    byKey: new Map(s.rows.map((r) => [`${s.pre}${r.rid}`, r])),
  }));

  // the same person in more than one sheet: by the ID number, failing it by the name
  const identity = (r) => (r.idNumber ? `#${r.idNumber}` : `@${nameKey(r.name)}`);
  const sheetsOf = new Map();
  for (const t of kept.value.tabs) for (const r of t.rows) sheetsOf.set(identity(r), [...new Set([...(sheetsOf.get(identity(r)) || []), t.name])]);

  const tabsOfOld = new Map(); // "a<rid>" → the sheets where a line is that person
  const tabs = kept.value.tabs.map((t) => {
    const group = groupOf(t.name) || groupOf(t.rows[0]?.status);
    const found = new Map(); // the line → { key, sure, how/why, list }
    let left = t.rows.map((r) => ({ rid: r, name: r.name, phone: r.phone, line: r }));
    for (const side of sides) {
      const cross = crossCheck(left.map((x) => ({ ...x, idPerson: (x.line.idNumber && side.byNumber.get(x.line.idNumber)) || null })), side.people);
      for (const { row, person, how } of cross.pairs) found.set(row.line, { key: String(person._id), list: side.list, sure: true, how });
      for (const { row, person, why } of cross.check) found.set(row.line, { key: String(person._id), list: side.list, sure: false, why });
      left = left.filter((x) => !found.has(x.line));
    }
    const rows = t.rows.map((r, i) => {
      const hit = found.get(r);
      const side = hit && sides.find((s) => s.list === hit.list);
      const old = hit ? oldOut(side.byKey.get(hit.key), hit.list) : null;
      if (hit && hit.list === "students") tabsOfOld.set(hit.key, [...new Set([...(tabsOfOld.get(hit.key) || []), t.name])]);
      return {
        n: i + 1,
        name: r.name,
        status: r.status,
        frame: r.frame,
        course: r.course,
        residence: r.residence,
        mark: r.mark,
        note: r.note,
        red: r.red,
        hasId: Boolean(r.idNumber),
        idBad: r.idBad,
        hasPhone: Boolean(r.phone),
        also: (sheetsOf.get(identity(r)) || []).filter((name) => name !== t.name),
        match: old ? { ...old, sure: hit.sure, ...(hit.sure ? { how: hit.how } : { why: hit.why }), sameGroup: Boolean(group) && old.group === group } : null,
      };
    });
    return { name: t.name, group, label: GROUPS.find((g) => g.key === group)?.label || t.name, rows, taken: new Set([...found.values()].filter((h) => h.list === "students").map((h) => h.key)) };
  });

  // the other way: whom the active list puts in a program, and the program's sheet does not hold
  const groupsHeld = new Set(tabs.map((t) => t.group).filter(Boolean));
  const inTabs = (r) => tabsOfOld.get(`a${r.rid}`) || [];
  for (const t of tabs) {
    t.senzeyOnly = t.group ? students.filter((r) => groupOf(r.status) === t.group && !t.taken.has(`a${r.rid}`)).map((r) => ({ ...oldOut(r, "students"), inTabs: inTabs(r) })) : [];
    delete t.taken;
  }
  const others = students.filter((r) => !groupsHeld.has(groupOf(r.status))).map((r) => ({ ...oldOut(r, "students"), inTabs: inTabs(r) }));

  return {
    source: kept.value.source || "",
    takenAt: kept.value.takenAt || null,
    loadedAt: kept.updatedAt || null,
    loadedBy: kept.updatedBy || "",
    senzey: { students: students.length, potential: potential.length },
    tabs,
    others,
  };
}

module.exports = { get, set, clear, groupOf };
