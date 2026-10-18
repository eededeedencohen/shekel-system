/**
 * A persona reads its own data families and nothing of another program's
 * (Eden, 2026-10-18: "ייטענו… אך ורק הנתונים הרלוונטים… גם מטעמי אבטחה
 * והרשאות"). utils/auth requireFamily on the ACTING persona - so the super
 * admin viewing as someone is refused exactly what that someone is.
 *
 * Runs with AUTH_ENFORCE=1 so req.actor is the real persona.
 */

const request = require("supertest");
const app = require("../../../app");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));

/** One read per family - the list the client's slices come from. */
const READS = {
  college: "/api/cycles",
  culture: "/api/events",
  hostels: "/api/hostels",
  library: "/api/library/books",
  invoices: "/api/invoices",
  suppliers: "/api/suppliers",
  // everyone's
  people: "/api/people",
  intakes: "/api/intakes",
};

/** Which families each seeded kind may read (mirrors utils/auth FAMILIES and the client's slicesFor). */
const MAY = {
  eden: ["college", "culture", "hostels", "library", "invoices", "suppliers"], // super
  hagai: ["college", "invoices"], // manager
  yetav: ["college", "culture", "hostels"], // social
  tamar: ["college", "hostels", "invoices", "suppliers"], // hostels
  shiran: ["culture"], // culture
};

describe("requireFamily - a persona reads only its own data", () => {
  beforeEach(async () => {
    await ensureSeedAccounts();
  });

  for (const [username, allowed] of Object.entries(MAY)) {
    it(`${username}: ${allowed.join(", ")} - and 403 on the rest`, async () => {
      const cookie = await signIn(username);
      for (const [family, path] of Object.entries(READS)) {
        const res = await request(app).get(path).set("Cookie", cookie);
        const open = family === "people" || family === "intakes" || allowed.includes(family);
        expect(`${family} ${res.status}`).toBe(`${family} ${open ? 200 : 403}`);
        if (!open && family !== "suppliers") expect(res.body.code).toBe("OUT_OF_SCOPE");
      }
    });
  }

  it("the super admin viewing as שירן is refused what שירן is refused", async () => {
    const eden = await signIn("eden");
    const staff = (await request(app).get("/api/auth/staff").set("Cookie", eden)).body.data.staff;
    const shiran = staff.find((a) => a.kind === "culture");
    const asShiran = (path) => request(app).get(path).set("Cookie", eden).set("X-Acting-As", String(shiran._id));
    expect((await asShiran("/api/events")).status).toBe(200);
    expect((await asShiran("/api/cycles")).status).toBe(403);
    expect((await asShiran("/api/library/books")).status).toBe(403);
    // as himself again - everything
    expect((await request(app).get("/api/cycles").set("Cookie", eden)).status).toBe(200);
  });
});
