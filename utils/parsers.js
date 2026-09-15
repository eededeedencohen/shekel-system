/**
 * @file Pure parsers used by the seed pipeline
 * @module utils/parsers
 *
 * Side-effect-free transforms for raw cell strings → typed values.
 * Kept in a dedicated module so they are unit-testable in isolation
 * (no DB, no filesystem, no env required).
 */

/**
 * Split a Hebrew full-name into first/last. The source sheet uses the
 * "firstName lastName" convention (e.g. "שי חזן" → first "שי", last "חזן").
 * Compound surnames may split incorrectly (e.g. "בן אילוז" → first "בן",
 * last "אילוז"); these are reviewed in the exported CSV.
 *
 * @param {string} raw
 * @returns {{ firstName: string, lastName: string }}
 */
function splitName(raw) {
  const parts = (raw || "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "-", lastName: "-" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "-" };
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
}

/**
 * Parse a senzey-style date into a Date. Accepts both
 *   "DD/MM/YYYY"          (e.g. "28/04/2026")
 *   "DD/MM/YYYY HH:MM"    (e.g. "28/04/2026 14:06")
 * Returns undefined on malformed input so Mongoose simply omits the
 * field rather than storing Invalid Date.
 *
 * @param {string} raw
 * @returns {Date | undefined}
 */
function parseDate(raw) {
  if (!raw) return undefined;
  const m = String(raw)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh = "00", mi = "00"] = m;
  const iso =
    `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}` +
    `T${hh.padStart(2, "0")}:${mi.padStart(2, "0")}:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Map Hebrew gender labels to the User.gender enum.
 *
 * @param {string} raw
 * @returns {"male" | "female" | undefined}
 */
function parseGender(raw) {
  if (!raw) return undefined;
  if (raw.includes("זכר")) return "male";
  if (raw.includes("נקבה")) return "female";
  return undefined;
}

/**
 * Strip BiDi / zero-width / BOM control characters that the source HTML
 * inserts around mixed Hebrew-English text. These codepoints are
 * invisible but break naive string handling and surface as `[U+2069]`
 * in JSON viewers.
 *
 * @param {unknown} s
 * @returns {string}
 */
function cleanText(s) {
  if (s == null) return "";
  return String(s)
    .replace(/[​-‏⁦-⁩‪-‮﻿]/g, "")
    .trim();
}

module.exports = { splitName, parseDate, parseGender, cleanText };
