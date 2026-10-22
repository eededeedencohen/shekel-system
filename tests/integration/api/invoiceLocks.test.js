/**
 * The locks of the invoices' state machine (2026-10-22, decisions 1 and 8
 * and case 17): an invoice that came through a teacher's link is the
 * staff's to change or delete only while the teacher's month is open and
 * the mail has not gone; its lessons are the teacher's word; the super
 * admin's corrections are his alone, as himself; a staff member checking a
 * link is not the teacher opening it.
 *
 * Runs with AUTH_ENFORCE=1 so req.actor is the real persona.
 */

const request = require("supertest");
const app = require("../../../app");
const InvoiceRequest = require("../../../models/InvoiceRequest");
const StaffAccount = require("../../../models/StaffAccount");
const { ensureSeedAccounts } = require("../../../services/authService");
const { defaultPasswordFor } = require("../../../utils/password");
const tags = require("../../../services/tagService");
const { makeTeacher, makeHostel, makeCycle, makeSubject } = require("../../helpers/factories");

beforeAll(() => {
  process.env.AUTH_ENFORCE = "1";
});
afterAll(() => {
  delete process.env.AUTH_ENFORCE;
});

const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const signIn = async (username) => cookieOf(await request(app).post("/api/auth/login").send({ username, password: defaultPasswordFor(username) }));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = `data:image/png;base64,${PNG_B64}`;

describe("the locks of a link invoice, and the super admin's door", () => {
  let eden;
  let tamar;
  let tamarId;
  beforeEach(async () => {
    await ensureSeedAccounts();
    eden = await signIn("eden");
    tamar = await signIn("tamar");
    tamarId = String((await StaffAccount.findOne({ username: "tamar" }))._id);
  });

  /** A hostels month opened by תמר, with one invoice in through אביה's link. */
  async function monthWithInvoice() {
    const hostel = await makeHostel({ name: "שיירות" });
    const subject = await makeSubject({ name: "עיצוב גרפי" });
    const teacher = await makeTeacher({ firstName: "אביה", lastName: "טסט", gender: "female" });
    const cycle = await makeCycle({ subject: subject._id, teacher: teacher._id, hostel: hostel._id, startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31"), schedule: [{ day: 4, start: "15:00", end: "16:00" }] });
    await tags.setCycleProgram({ world: "real", cycleId: cycle._id, key: "hostels" });
    const round = (await request(app).post("/api/invoice-rounds").set("Cookie", tamar).send({ month: "2026-10" })).body.data.round;
    const req0 = round.requests[0];
    const url = `/api/public/invoices/${req0.token}`;
    const view = (await request(app).get(url)).body.data.view;
    const ids = view.courses[0].sessions.map((s) => s._id);
    const up = await request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: "a.png", sessions: [ids[0], ids[1]] });
    return { round, req0, url, ids, invoice: up.body.data.view.invoices[0] };
  }
  const upload = (url, sessions, name = "b.png") => request(app).post(`${url}/invoices`).send({ imageData: IMAGE, imageName: name, sessions });
  const staffRequest = async (roundId, cookie) => (await request(app).get(`/api/invoice-rounds/${roundId}`).set("Cookie", cookie)).body.data.round.requests[0];
  const shaped = async (id, cookie) => (await request(app).get(`/api/invoices/${id}`).set("Cookie", cookie)).body.data.invoice;

  it("the hostels coordinator deletes a link invoice while the month is open, never after the teacher finished or the mail went; the super admin always", async () => {
    const { round, req0, url, ids, invoice } = await monthWithInvoice();
    expect(await shaped(invoice._id, tamar)).toMatchObject({ viaLink: true, locked: null });
    expect((await request(app).delete(`/api/invoices/${invoice._id}`).set("Cookie", tamar)).status).toBe(204);
    const inv2 = (await upload(url, [ids[0]])).body.data.view.invoices[0];
    // the lessons of a link invoice are the teacher's word (case 17): the note is hers to change, the lessons the super admin's
    const lesson = (await staffRequest(round._id, tamar)).sessions[0].lesson;
    const moved = await request(app).patch(`/api/invoices/${inv2._id}`).set("Cookie", tamar).send({ lessons: [lesson] });
    expect(moved.status).toBe(403);
    expect(moved.body.code).toBe("INVOICE_LINK_LESSONS");
    expect((await request(app).patch(`/api/invoices/${inv2._id}`).set("Cookie", tamar).send({ note: "הערה" })).status).toBe(200);
    expect((await request(app).patch(`/api/invoices/${inv2._id}`).set("Cookie", eden).send({ lessons: [lesson] })).status).toBe(200);
    // the teacher finished: locked for her, open for him
    await request(app).post(`${url}/done`).send({});
    const locked = await request(app).delete(`/api/invoices/${inv2._id}`).set("Cookie", tamar);
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("INVOICE_LOCKED");
    expect((await shaped(inv2._id, tamar)).locked).toBe("done");
    expect((await request(app).patch(`/api/invoices/${inv2._id}`).set("Cookie", tamar).send({ note: "עוד" })).status).toBe(403);
    // opened back: hers again; the mail gone: locked again
    await request(app).post(`/api/invoice-rounds/${round._id}/requests/${req0._id}/reopen`).set("Cookie", tamar).send({});
    expect((await shaped(inv2._id, tamar)).locked).toBeNull();
    await request(app).post(`/api/invoice-rounds/${round._id}/mail`).set("Cookie", tamar).send({ sent: true });
    expect((await shaped(inv2._id, tamar)).locked).toBe("mailed");
    expect((await request(app).delete(`/api/invoices/${inv2._id}`).set("Cookie", tamar)).status).toBe(403);
    expect((await request(app).delete(`/api/invoices/${inv2._id}`).set("Cookie", eden)).status).toBe(204);
    expect((await staffRequest(round._id, tamar)).invoices).toHaveLength(0);
  });

  it("the corrections are the super admin's alone, as himself; a staff member checking a link is not the teacher opening it", async () => {
    const { round, req0, url } = await monthWithInvoice();
    const act = (cookie, extra = {}) => {
      const r = request(app).post(`/api/invoice-rounds/${round._id}/admin`).set("Cookie", cookie);
      if (extra.actingAs) r.set("X-Acting-As", extra.actingAs);
      return r.send({ action: "requestsSync" });
    };
    expect((await act(tamar)).status).toBe(403);
    expect((await act(eden, { actingAs: tamarId })).status).toBe(403);
    const ok = await act(eden);
    expect(ok.status).toBe(200);
    expect(ok.body.data.did.requests).toBe(0);
    // decision 8: a signed-in staff member's look at the link leaves no "נפתח"; the teacher's does
    await InvoiceRequest.updateOne({ _id: req0._id }, { $unset: { openedAt: 1, lastOpenedAt: 1 } });
    expect((await request(app).get(url).set("Cookie", eden)).status).toBe(200);
    expect((await InvoiceRequest.findById(req0._id)).openedAt).toBeFalsy();
    expect((await request(app).get(url)).status).toBe(200);
    expect((await InvoiceRequest.findById(req0._id)).openedAt).toBeTruthy();
  });
});
