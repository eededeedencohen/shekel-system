/**
 * The super admin's cost meter (Eden, 2026-10-26: "מד לפי חודש כמה עולה
 * לי השירותי של אמזון"): Cost Explorer's answer shaped into months, the
 * month so far and a forecast; without the account's permission the card
 * is told why; the answer is cached (a Cost Explorer call costs a cent).
 */

const request = require("supertest");
const app = require("../../../app");
const costs = require("../../../services/awsCostService");

const ce = (months) => ({
  ResultsByTime: months.map(([start, groups, estimated]) => ({
    TimePeriod: { Start: `${start}-01`, End: `${start}-28` },
    Estimated: !!estimated,
    Groups: groups.map(([service, amount]) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: String(amount), Unit: "USD" } } })),
  })),
});

afterEach(() => costs._setClientFactory(null));

describe("GET /api/db/costs", () => {
  it("shapes six months by service, the month so far and the forecast; the answer is cached", async () => {
    let calls = 0;
    costs._setClientFactory(() => ({
      costAndUsage: async () => {
        calls++;
        return ce([
          ["2026-05", [["Amazon Simple Storage Service", 0.1]]],
          ["2026-06", []],
          ["2026-07", [["Amazon Simple Storage Service", 0.2], ["Tax", 0.03]]],
          ["2026-08", [["Amazon Simple Storage Service", 0.25]]],
          ["2026-09", [["Amazon Simple Storage Service", 0.3]]],
          ["2026-10", [["Amazon Simple Storage Service", 0.12]], true],
        ]);
      },
      forecast: async () => ({ Total: { Amount: "0.2", Unit: "USD" } }),
    }));
    const res = await request(app).get("/api/db/costs?fresh=1");
    expect(res.status).toBe(200);
    const c = res.body.data.costs;
    expect(c.available).toBe(true);
    expect(c.currency).toBe("USD");
    expect(c.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(c.months[2]).toMatchObject({ total: 0.23, byService: { "Amazon Simple Storage Service": 0.2, Tax: 0.03 } });
    expect(c.months[1].total).toBe(0);
    const thisMonth = new Date().toISOString().slice(0, 7);
    if (thisMonth === "2026-10") {
      expect(c.current).toMatchObject({ month: "2026-10", total: 0.12, estimated: true });
      expect(c.forecast.total).toBe(0.32);
    } else {
      expect(c.current.month).toBe(thisMonth);
    }
    const again = await request(app).get("/api/db/costs");
    expect(again.body.data.costs.available).toBe(true);
    expect(calls).toBe(1); // cached
  });

  it("without the permission (or Cost Explorer) the card is told why", async () => {
    costs._setClientFactory(() => ({
      costAndUsage: async () => {
        const e = new Error("User: arn:aws:iam::1:user/shekel-app is not authorized to perform: ce:GetCostAndUsage");
        e.name = "AccessDeniedException";
        throw e;
      },
      forecast: async () => ({}),
    }));
    const res = await request(app).get("/api/db/costs?fresh=1");
    expect(res.status).toBe(200);
    expect(res.body.data.costs).toMatchObject({ available: false, reason: "no-permission" });
  });

  it("without keys at all it says so", async () => {
    costs._setClientFactory(() => null);
    const res = await request(app).get("/api/db/costs?fresh=1");
    expect(res.body.data.costs).toMatchObject({ available: false, reason: "no-credentials" });
  });
});
