/**
 * Cycle model — date ordering, the venue⊕campus-room exclusivity that keeps
 * the derived `site` unambiguous, and the virtuals.
 */

const { makeCycle, makeRoom, makeHostel } = require("../../helpers/factories");

describe("date order", () => {
  it("rejects endDate before startDate", async () => {
    await expect(
      makeCycle({ startDate: new Date("2026-06-01"), endDate: new Date("2026-03-01") })
    ).rejects.toThrow(/מאוחר יותר/);
  });
});

describe("site derivation stays unambiguous", () => {
  it("campus room on a slot → site 'campus'", async () => {
    const room = await makeRoom();
    const cycle = await makeCycle({
      schedule: [{ day: 1, start: "09:00", end: "10:00", room: room._id }],
    });
    expect(cycle.site).toBe("campus");
  });

  it("venue.hostel → site 'hostel'; venue.label → 'external'; none → null", async () => {
    const hostel = await makeHostel();
    const atHostel = await makeCycle({ venue: { hostel: hostel._id, label: "סלון" } });
    expect(atHostel.site).toBe("hostel");
    const external = await makeCycle({ venue: { label: "האקדמיה גבעת-רם" } });
    expect(external.site).toBe("external");
    const unknown = await makeCycle({});
    expect(unknown.site).toBeNull();
  });

  it("REJECTS a campus room alongside a venue — the two can never contradict", async () => {
    const room = await makeRoom();
    const hostel = await makeHostel();
    await expect(
      makeCycle({
        schedule: [{ day: 1, start: "09:00", end: "10:00", room: room._id }],
        venue: { hostel: hostel._id },
      })
    ).rejects.toThrow(/venue/);
  });
});

describe("isClassified virtual", () => {
  it("true only when capacity + age range + levels are all present", async () => {
    const bare = await makeCycle();
    expect(bare.isClassified).toBe(false);
    const classified = await makeCycle({
      matching: { capacity: 8, ageMin: 18, ageMax: 60, functioningLevels: ["High", "Medium"] },
    });
    expect(classified.isClassified).toBe(true);
  });
});

describe("schedule slots", () => {
  it("validates slot times through the shared TimeRange", async () => {
    await expect(
      makeCycle({ schedule: [{ day: 3, start: "12:00", end: "11:00" }] })
    ).rejects.toThrow(/אחרי שעת ההתחלה/);
  });
});
