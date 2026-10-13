/**
 * הוסטלים - the managed entity and its general details (Eden, 2026-10-13:
 * a hostel's page opens on a dashboard with "פרטים כלליים של ההוסטל").
 */

const request = require("supertest");
const app = require("../../../app");
const Hostel = require("../../../models/Hostel");
const { makeHostel, makeCycle } = require("../../helpers/factories");

describe("/api/hostels", () => {
  it("creates a hostel with its details and lists it", async () => {
    const res = await request(app).post("/api/hostels").send({
      name: "הוסטל הבדיקה",
      address: "רחוב הדוגמה 3",
      city: "ירושלים",
      phone: "02-1234567",
      email: "House@Example.org",
      contact: { name: "רונית", role: "מנהלת הבית", phone: "050-0000000" },
      notes: "הקבוצה נפגשת בסלון",
    });
    expect(res.status).toBe(201);
    const h = res.body.data.hostel;
    expect(h).toMatchObject({ name: "הוסטל הבדיקה", address: "רחוב הדוגמה 3", city: "ירושלים", phone: "02-1234567", email: "house@example.org", notes: "הקבוצה נפגשת בסלון" });
    expect(h.contact).toMatchObject({ name: "רונית", role: "מנהלת הבית", phone: "050-0000000" });

    const list = await request(app).get("/api/hostels");
    expect(list.status).toBe(200);
    expect(list.body.data.hostels.map((x) => x.name)).toContain("הוסטל הבדיקה");

    const one = await request(app).get(`/api/hostels/${h._id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.hostel.name).toBe("הוסטל הבדיקה");
  });

  it("updates the details and only the details sent; the name may not be blanked", async () => {
    const h = await makeHostel({ address: "ישן 1", notes: "הערה" });
    const res = await request(app).put(`/api/hostels/${h._id}`).send({ phone: "03-7654321", contact: { name: "דני" } });
    expect(res.status).toBe(200);
    expect(res.body.data.hostel).toMatchObject({ address: "ישן 1", notes: "הערה", phone: "03-7654321" });
    expect(res.body.data.hostel.contact).toMatchObject({ name: "דני", role: "", phone: "" });

    const blank = await request(app).put(`/api/hostels/${h._id}`).send({ name: "   " });
    expect(blank.status).toBe(400);
    expect((await Hostel.findById(h._id)).name).toBe(h.name);

    const missing = await request(app).put(`/api/hostels/6aa128921cc122dde93a3577`).send({ phone: "1" });
    expect(missing.status).toBe(404);
  });

  it("refuses to delete a hostel a cycle points at, deletes a free one", async () => {
    const used = await makeHostel();
    await makeCycle({ hostel: used._id });
    const blocked = await request(app).delete(`/api/hostels/${used._id}`);
    expect(blocked.status).toBe(409);

    const free = await makeHostel();
    const ok = await request(app).delete(`/api/hostels/${free._id}`);
    expect(ok.status).toBe(204);
    expect(await Hostel.findById(free._id)).toBeNull();
  });

  it("keeps the worlds apart", async () => {
    const h = await makeHostel({ world: "test" });
    const real = await request(app).get(`/api/hostels/${h._id}`);
    expect(real.status).toBe(404);
    const test = await request(app).get(`/api/hostels/${h._id}`).set("X-Dataset", "test");
    expect(test.status).toBe(200);
  });
});
