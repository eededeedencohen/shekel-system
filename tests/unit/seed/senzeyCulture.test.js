/**
 * The pure half of the senzey culture importer: title → category, display
 * names, venues, and the dataset shape built from the two exports (no DB,
 * no repo files — small inline fixtures in the exports' exact formats).
 */

const {
  categoryOfTitle, displayTitle, locationOf, defaultStart, buildDataset, pseudonym, isPseudonym, UMBRELLA_ID, INTEREST_ID,
} = require("../../../scripts/lib/senzeyCulture");

describe("pseudonym — the test world never carries a real name", () => {
  it("is deterministic, gender-matched, and steps to a letter on collision", () => {
    const used = new Set();
    const a = pseudonym({ key: "111", gender: "female" }, used);
    const b = pseudonym({ key: "111", gender: "female" }, new Set());
    expect(a).toBe(b);
    expect(isPseudonym(a)).toBe(true);
    const again = pseudonym({ key: "111", gender: "female" }, used);
    expect(again).toBe(`${a} ב׳`);
    expect(isPseudonym(again)).toBe(true);
    expect(isPseudonym("גולדשטיין")).toBe(false);
    expect(isPseudonym("אהרן צבי")).toBe(false);
  });
});

describe("categoryOfTitle — the real תשפ\"ו titles land on the right kind", () => {
  const cases = [
    ['הצגה "החולה ההודי"', "theatre"],
    ['הצגה - " לנקות את הראש"', "theatre"],
    ["מופע מוזיקלי - \"קולולם\"", "concert"],
    ["נוקטורנו - \"זמן תפילות\"", "concert"],
    ["נקטורנו", "concert"],
    ["עופר שכטר", "concert"],
    ["קונצרט סוף שנה", "concert"],
    ['"שלומי קוריאט"', "standup"],
    ["גיא הוכמן", "standup"],
    ["מופע מחול לנשים", "dance"],
    ["סרט - יקבע בהמשך", "movie"],
    ["סרט בבוקר", "movie"],
    ["סיור מוזיאון המחתרות", "museum"],
    ["סיור יום ירושלים", "trip"],
    ["פיקניק בטבע וארוחת בוקר", "trip"],
    ["מוסא - צעירים", "restaurant"],
    ["ארומה מבוגרים", "restaurant"],
    ["גרג צעירים", "restaurant"],
    ["באולינג - קבוצה 2", "outing"],
    ["בוקר נשים", "community"],
    ["בוצר נשים", "community"],
    ["ערב הורים וילדים", "community"],
    ["ערב על האש", "community"],
    ["מפגש יום השואה", "community"],
    ["טקס יום הזיכרון", "community"],
    ["אימון טניס חוויתי", "sport"],
    ["סדנת אפיה עם שרה", "workshop"],
    ["סדנת כד וחומר", "workshop"],
    ["כלבנות טיפולית", "workshop"],
    ["פייטנות", "workshop"],
    ["סטודיו מדרחוב", "workshop"],
    ["סדנת סטילינג עם אפרת", "workshop"],
    ['סדנת כלים להתמודדות - "מחשבות מגבילות"', "workshop"],
    ["התנדבות - אריזות לחיילים", "volunteering"],
    ["מסיבת חנוכה", "party"],
    ["משהו אחר לגמרי", "other"],
  ];
  it.each(cases)("%s → %s", (title, key) => {
    expect(categoryOfTitle(title)).toBe(key);
  });
});

describe("displayTitle / locationOf / defaultStart", () => {
  it("fixes the coordinator's typos and spells out bare performer names", () => {
    expect(displayTitle("בוצר נשים")).toBe("בוקר נשים");
    expect(displayTitle("גיא הוכמן")).toBe("סטנדאפ — גיא הוכמן");
    expect(displayTitle('הצגה" הזוג המוזר"')).toBe('הצגה — "הזוג המוזר"');
    expect(displayTitle("מוסא - צעירים")).toBe("מוסא — צעירים");
    expect(displayTitle("  סדנת   אפיה ")).toBe("סדנת אפיה");
  });
  it("completes venues with the street numbers the raw names carry", () => {
    expect(locationOf({ venue: "מרכז פנאי · יד חרוצים" }, "סדנת אפיה")).toBe("מרכז פנאי · יד חרוצים 9");
    expect(locationOf({ venue: "קניון מלחה" }, "מוסא מבוגרים")).toBe("מסעדת מוסא · קניון מלחה");
    expect(locationOf({ venue: "סינמה סיטי" }, "גרג צעירים")).toBe("קפה גרג · סינמה סיטי");
    expect(locationOf({ venue: "סינמה סיטי" }, "סרט")).toBe("סינמה סיטי ירושלים · דרך רבין 10");
    expect(locationOf({ venue: null }, "ערב הורים וילדים")).toBe("מרכז פנאי · יד חרוצים 9");
    expect(locationOf({ venue: null }, "קונצרט סוף שנה")).toBeUndefined();
  });
  it("guesses the program's usual hour when senzey has none", () => {
    expect(defaultStart("theatre", "הצגה")).toBe("20:15");
    expect(defaultStart("movie", "סרט בבוקר")).toBe("11:00");
    expect(defaultStart("movie", "סרט בערב")).toBe("18:30");
    expect(defaultStart("workshop", "סדנה")).toBe("17:00");
  });
});

describe("buildDataset — the two exports become members, guests, outings, cancellations", () => {
  const CAT = "תרבות לכל (יציאות בקהילה)";
  const html = (course, name, idn, type, regAt, id = "1500", date = "05/05/2026", price = "0.00") =>
    [id, course, CAT, name, idn, type, "ג`", "17:00", "דרעי שירן", date, "מחיר קבוע", price, regAt];
  const jsonRow = (courseId, course, name, idn, type, regAt, source) => ({
    "מזהה קורס": courseId, "שם קורס": course, "סוג קורס": CAT, "סטודנט": name, "ת.ז.": idn, "סוג סטודנט": type,
    "מנהל קורס": "דרעי שירן", "תאריך הרשמה": regAt, "מקור רישום": source, "סוג החיוב": "לא לחיוב", "מחיר": "",
  });
  const payload = {
    rows: [
      html("סדנת אפיה - פנאי - יד חרוצים 9 - 5.5 - ג` - 17:00", "דנה כהן", "111", "מתמודד/ת", "20/04/2026 10:00"),
      html("סדנת אפיה - פנאי - יד חרוצים 9 - 5.5 - ג` - 17:00", "יוסי לוי", "222", "מתמודד/ת", "21/04/2026 10:00"),
      html("סדנת אפיה - פנאי - יד חרוצים 9 - 5.5 - ג` - 17:00", "אמא של דנה", "333", "אורח/ת", "22/04/2026 10:00"),
      html("תרבות לכל (תשפו)", "דנה כהן", "111", "מתמודד/ת", "01/09/2025 09:00", UMBRELLA_ID, "01/09/2025", "240.00"),
      html("פייטנות - ב` - 19:00", "יוסי לוי", "222", "מתמודד/ת", "01/10/2025 09:00", "1321", ""),
      [INTEREST_ID, "מתעניין/ת בתרבות לכל", "מחלקת תרבות ופנאי (רישום לתוכניות)", "רונית מזרחי", "444", "מתמודד/ת", "", "", "דרעי שירן", "", "", "", "01/02/2026 11:00"],
      ["1600", "אנגלית - שעיה", "מכללה לכל (קבוצתי)", "סטודנט מכללה", "999", "מתמודד/ת", "", "", "מישהו", "01/01/2026", "", "", "01/01/2026 10:00"],
    ],
    meta: {
      1500: { kind: "event", date: "2026-05-05", start: "17:00", end: "19:00", title: "סדנת אפיה", venue: "מרכז פנאי · יד חרוצים" },
      [UMBRELLA_ID]: { kind: "weekly", date: null, title: "תרבות לכל" },
      1321: { kind: "weekly", date: null, title: "פייטנות", venue: "מרכז פנאי · יד חרוצים" },
      [INTEREST_ID]: { kind: "list", date: null, title: "מתעניינים: תרבות לכל" },
    },
  };
  const json = {
    records: [
      jsonRow("1500", "סדנת אפיה - פנאי - יד חרוצים 9 - 5.5 - ג` - 17:00", "דנה כהן", "111", "מתמודד/ת", "20/04/2026 10:00", "דף נחיתה #31"),
      jsonRow("1500", "סדנת אפיה - פנאי - יד חרוצים 9 - 5.5 - ג` - 17:00", "משה ביטון", "555", "מתמודד/ת", "19/04/2026 10:00", ""),
    ],
  };
  const clients = [
    { id: "2001", identify_number: "111", name: "דנה כהן", client_status: "משובץ-תרבות לכל", client_type: "מתמודד/ת", birthday: "18/01/1995 (31.25)", gender: "נקבה", mobile: "050-000-0001", email1: "dana@example.com", ind_emergencyname: "אמא", ind_emergencyphone2: "050-000-0002", ind_coordinator: "מירון", ind_coordinator_phone: "054", ind_coordinator_organization: "אור" },
  ];
  const students = [{ id: "2002", nationalId: "222", name: "יוסי לוי", status: "משובץ-תרבות לכל", phone: "052-1" }];
  const ds = buildDataset({ payload, json, clients, students });

  it("keeps only the culture category and turns the dated course into one outing", () => {
    expect([...ds.courses.keys()]).toEqual(["1500"]);
    const c = ds.courses.get("1500");
    expect(c.title).toBe("סדנת אפיה");
    expect(c.category).toBe("workshop");
    expect(c.location).toBe("מרכז פנאי · יד חרוצים 9");
    expect(c.endTime).toBe("19:00");
    expect(c.date.getFullYear()).toBe(2026);
    expect(c.gender).toBe("all");
    expect(ds.skipped.map((s) => s.id).sort()).toEqual([UMBRELLA_ID, "1321"].sort());
  });
  it("merges the exports: source from the older one, its extra row becomes a cancellation", () => {
    const rows = ds.courses.get("1500").rows;
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.idn === "111").source).toBe("דף נחיתה #31");
    expect(rows.find((r) => r.idn === "555").cancelled).toBe(true);
    expect(rows.filter((r) => r.cancelled)).toHaveLength(1);
  });
  it("tells members, guests and leads apart and enriches from the master files", () => {
    expect(ds.members.map((p) => p.name).sort()).toEqual(["דנה כהן", "יוסי לוי", "משה ביטון"].sort());
    expect(ds.guestsOnly.map((p) => p.name)).toEqual(["אמא של דנה"]);
    expect(ds.leads.map((p) => p.name)).toEqual(["רונית מזרחי"]);
    const dana = ds.members.find((p) => p.name === "דנה כהן");
    expect(dana.clientId).toBe("2001");
    expect(dana.gender).toBe("female");
    expect(dana.email).toBe("dana@example.com");
    expect(dana.birthDate.getFullYear()).toBe(1995);
    expect(dana.joinAt.getFullYear()).toBe(2025);
    expect(dana.billing).toBe("מחיר קבוע 240.00");
    const yossi = ds.members.find((p) => p.name === "יוסי לוי");
    expect(yossi.clientId).toBe("2002");
    expect(yossi.phone).toBe("052-1");
    expect(ds.people.has("999")).toBe(false);
  });
});
