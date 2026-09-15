/**
 * Unit tests for utils/parsers — the pure functions that normalise raw
 * cell strings during the seed import. No DB or filesystem required.
 */

const {
  splitName,
  parseDate,
  parseGender,
  cleanText,
} = require("../../../utils/parsers");

describe("splitName", () => {
  it('splits "firstName lastName" correctly', () => {
    expect(splitName("שי חזן")).toEqual({
      firstName: "שי",
      lastName: "חזן",
    });
  });

  it("treats a single token as firstName, lastName as placeholder", () => {
    expect(splitName("מירי")).toEqual({
      firstName: "מירי",
      lastName: "-",
    });
  });

  it("returns placeholders for empty input", () => {
    expect(splitName("")).toEqual({ firstName: "-", lastName: "-" });
    expect(splitName(null)).toEqual({ firstName: "-", lastName: "-" });
  });

  it("joins surname tokens after the first", () => {
    expect(splitName("חוסאם אבו דיאב")).toEqual({
      firstName: "חוסאם",
      lastName: "אבו דיאב",
    });
  });
});

describe("parseDate", () => {
  it("parses DD/MM/YYYY into a Date", () => {
    const d = parseDate("14/03/1996");
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(1996);
    expect(d.getMonth()).toBe(2); // March → 2 (0-indexed)
    expect(d.getDate()).toBe(14);
  });

  it("returns undefined for malformed input", () => {
    expect(parseDate("not a date")).toBeUndefined();
    expect(parseDate("2026-01-01")).toBeUndefined(); // wrong format
    expect(parseDate("")).toBeUndefined();
    expect(parseDate(null)).toBeUndefined();
  });
});

describe("parseGender", () => {
  it("maps Hebrew labels to enum values", () => {
    expect(parseGender("זכר")).toBe("male");
    expect(parseGender("נקבה")).toBe("female");
  });

  it("returns undefined for empty / unknown input", () => {
    expect(parseGender("")).toBeUndefined();
    expect(parseGender(null)).toBeUndefined();
    expect(parseGender("unknown")).toBeUndefined();
  });
});

describe("cleanText", () => {
  it("strips bidi control characters", () => {
    expect(cleanText("054-467-6685⁩")).toBe("054-467-6685");
    expect(cleanText("‪052-538-5177‬")).toBe("052-538-5177");
  });

  it("strips zero-width characters", () => {
    expect(cleanText("hello​world")).toBe("helloworld");
  });

  it("strips BOM", () => {
    expect(cleanText("﻿value")).toBe("value");
  });

  it("trims surrounding whitespace", () => {
    expect(cleanText("  hello  ")).toBe("hello");
  });

  it("handles null / undefined", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });
});
