/**
 * The staff's "service recipients" workbook beside the old system's lists (/api/tag-plan/recipients): a picture for
 * the ideas page - every line of a sheet is looked for in the old system, and the old system's people of a program
 * are looked for in the program's sheet. The super admin's alone; no ID number and no phone is in an answer.
 */

const request = require("supertest");
const app = require("../../../app");
const { TEST_ACCOUNT } = require("../../../utils/auth");
const AppSetting = require("../../../models/AppSetting");

afterEach(() => {
  TEST_ACCOUNT.kind = "super";
});

const old = (rid, name, status, extra = {}) => ({ rid, name, idNumber: "", phone: "", type: "מתמודד/ת", status, residence: "", frame: "", ...extra });
const line = (name, extra = {}) => ({ name, idNumber: "", phone: "", status: "מכללה לכל", ...extra });
const put = (body) => request(app).put("/api/tag-plan/recipients").send(body);
const get = async () => (await request(app).get("/api/tag-plan/recipients")).body.data.sheet;

describe("the service recipients workbook beside the old system", () => {
  it("is the super admin's alone, and empty until a workbook is loaded", async () => {
    expect(await get()).toBeNull();
    TEST_ACCOUNT.kind = "manager";
    expect((await request(app).get("/api/tag-plan/recipients")).status).toBe(403);
    expect((await put({ tabs: [{ name: "מכללה לכל", rows: [line("א ב")] }] })).status).toBe(403);
  });

  it("refuses a workbook that is not whole", async () => {
    expect((await put({ tabs: [] })).body.code).toBe("TAG_PLAN_INVALID");
    expect((await put({ tabs: [{ name: "מכללה לכל", rows: [{ name: " " }] }] })).status).toBe(400);
    expect((await put({ tabs: [{ name: "", rows: [] }] })).status).toBe(400);
    expect(await AppSetting.countDocuments({ key: "recipients" })).toBe(0);
  });

  it("finds every line in the old system, says how, and lists who the old system holds and the sheet does not", async () => {
    await AppSetting.create({
      key: "oldStudents",
      value: {
        rows: [
          old("1", "דנה לוי", "משובץ-מכללה לכל", { idNumber: "123456782", frame: "קידום", residence: "גר לבד" }),
          old("2", "כהן יוסי", "משובץ-מכללה לכל", { phone: "052-2222222" }),
          old("3", "מיכל אברהם", "משובץ-תרבות לכל"),
          old("4", "רק בסנזי", "משובץ-מכללה לכל"),
          old("5", "שלומית בן דויד", "משובץ-מכללה לכל"),
          old("6", "אורח אחד", "אורח"),
          old("7", "גר בהוסטל", "הוסטלים", { frame: "הוסטל ליבא" }),
        ],
      },
    });
    await AppSetting.create({ key: "oldPotential", value: { rows: [old("90", "פוטנציאלית אחת", "מתעניין-מכללה לכל", { idNumber: "987654324" })] } });

    const res = await put({
      source: "בדיקה.xlsx",
      takenAt: "2026-11-25T10:00:00.000Z",
      tabs: [
        {
          name: "מכללה לכל",
          rows: [
            line("דנה לוי-שם אחר", { idNumber: "123456782", frame: "קידום", course: "ציור", note: "הערה", red: true }),
            line("יוסי כהן", { phone: "0522222222" }),
            line("מיכל אברהם"),
            line("שלומית בן דוד"),
            line("פוטנציאלית אחת", { idNumber: "987654324" }),
            line("לא קיים בכלל", { idNumber: "111111111" }),
          ],
        },
        { name: "תרבות לכל", rows: [line("מיכל אברהם", { status: "משובץ-תרבות לכל" })] },
        { name: "הוסטלים", rows: [] },
      ],
    });
    expect(res.status).toBe(200);
    const sheet = res.body.data.sheet;
    expect(sheet).toMatchObject({ source: "בדיקה.xlsx", senzey: { students: 7, potential: 1 } });
    const [college, culture, hostels] = sheet.tabs;
    expect(college).toMatchObject({ name: "מכללה לכל", group: "college" });
    const byName = (tab, name) => tab.rows.find((r) => r.name === name);

    // the same ID number under another name
    expect(byName(college, "דנה לוי-שם אחר")).toMatchObject({ n: 1, hasId: true, idBad: false, red: true, course: "ציור", match: { list: "students", rid: "1", sure: true, how: "id", name: "דנה לוי", sameGroup: true, frame: "קידום" } });
    // the same phone and a name that agrees
    expect(byName(college, "יוסי כהן")).toMatchObject({ hasId: false, hasPhone: true, match: { rid: "2", how: "phone", sure: true } });
    // the same name - and the old system's status speaks of ANOTHER program; the person stands in two sheets
    expect(byName(college, "מיכל אברהם")).toMatchObject({ also: ["תרבות לכל"], match: { rid: "3", how: "name", sameGroup: false, group: "culture" } });
    expect(byName(culture, "מיכל אברהם")).toMatchObject({ also: ["מכללה לכל"], match: { rid: "3", sameGroup: true } });
    // a name a letter away: likely, for a person to decide
    expect(byName(college, "שלומית בן דוד").match).toMatchObject({ rid: "5", sure: false, why: "nameClose" });
    // not in the active list, found among the potential
    expect(byName(college, "פוטנציאלית אחת").match).toMatchObject({ list: "potential", rid: "90", how: "id" });
    // nobody - and the ID typed in the sheet is not a real one
    expect(byName(college, "לא קיים בכלל")).toMatchObject({ match: null, hasId: true, idBad: true });

    // the other way: the active list's people of the program whom its sheet does not hold
    expect(college.senzeyOnly.map((r) => r.rid)).toEqual(["4"]);
    expect(culture.senzeyOnly).toEqual([]);
    expect(hostels.senzeyOnly).toMatchObject([{ rid: "7", frame: "הוסטל ליבא", inTabs: [] }]);
    // and whoever the active list holds under a status that is none of the sheets' programs
    expect(sheet.others.map((r) => r.rid)).toEqual(["6"]);

    // no number travels: not the workbook's, not the old system's
    const again = await request(app).get("/api/tag-plan/recipients");
    for (const secret of ["123456782", "987654324", "111111111", "2222222", "idNumber", '"phone":']) expect(again.text).not.toContain(secret);

    expect((await request(app).delete("/api/tag-plan/recipients")).status).toBe(200);
    expect(await get()).toBeNull();
  });
});
