/**
 * @file exportStudentsCSV — produce a clean CSV from סטודנטים.xls
 * @module scripts/exportStudentsCSV
 *
 * Parses the HTML-encoded Excel export, filters to rows whose status
 * contains "מכללה לכל", and writes a normalised, review-ready CSV with
 * a stable column ordering and Hebrew-friendly UTF-8 BOM (so Excel
 * opens it without garbling).
 *
 * Source columns of interest (by index in the original sheet):
 *   0  מזהה                    13 גיל
 *   1  שם                       14 פעיל?
 *   2  סטטוס סטודנט             16 מצב משפחתי
 *   3  ת.ז.                     17 ילדים
 *   4  אימייל                   18 הערות
 *   5  אימייל 2                 26 איש קשר למקרה חירום
 *   6  נייד                     27 טלפון למקרה חירום
 *   7  נייד 2                   28 מסגרת
 *   8  כתובת מגורים             29 מקום מגורים
 *   9  עיר
 *   11 מין
 *   12 תאריך לידה
 *
 * Note on names: the source mixes "firstName lastName" and
 * "lastName firstName" orderings. We keep the raw `fullName` column
 * and provide a best-effort split (assuming firstName-first, the more
 * common Hebrew convention). Review the CSV before importing back.
 *
 * Usage:  node scripts/exportStudentsCSV.js
 */

const fs = require("fs");
const path = require("path");

const SOURCE = path.join(__dirname, "..", "..", "סטודנטים מעודכן.xls");
const OUTPUT = path.join(__dirname, "..", "..", "students_clean.csv");

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function parseTable(html) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      cells.push(
        c[1].replace(/&nbsp;/g, "").replace(/<[^>]+>/g, "").trim()
      );
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Row → clean object
// ---------------------------------------------------------------------------

function splitName(raw) {
  const parts = (raw || "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  // Assume firstName-first (most common Hebrew convention).
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
}

function normalisePhone(raw) {
  if (!raw) return "";
  // Strip non-digits then re-format Israeli mobile patterns 0XX-XXX-XXXX.
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function normaliseGender(raw) {
  if (!raw) return "";
  if (raw.includes("זכר")) return "זכר";
  if (raw.includes("נקבה")) return "נקבה";
  return raw;
}

function rowToStudent(r) {
  const fullName = r[1] || "";
  const { firstName, lastName } = splitName(fullName);
  return {
    id: r[0] || "",
    fullName,
    firstName,
    lastName,
    status: r[2] || "",
    tz: r[3] || "",
    email: (r[4] || "").toLowerCase(),
    email2: (r[5] || "").toLowerCase(),
    phone: normalisePhone(r[6]),
    phone2: normalisePhone(r[7]),
    address: r[8] || "",
    city: r[9] || "",
    gender: normaliseGender(r[11]),
    birthDate: r[12] || "",
    age: r[13] || "",
    active: r[14] === "1" ? "כן" : r[14] === "0" ? "לא" : "",
    maritalStatus: r[16] || "",
    hasChildren: r[17] === "1" ? "כן" : r[17] === "0" ? "לא" : "",
    notes: r[18] || "",
    emergencyContact: r[26] || "",
    emergencyPhone: normalisePhone(r[27]),
    framework: r[28] || "",
    residenceType: r[29] || "",
  };
}

// ---------------------------------------------------------------------------
// CSV writing (RFC 4180 style, with UTF-8 BOM for Excel)
// ---------------------------------------------------------------------------

const HEADERS = [
  { key: "id", label: "מזהה" },
  { key: "fullName", label: "שם מלא (מקור)" },
  { key: "firstName", label: "שם פרטי" },
  { key: "lastName", label: "שם משפחה" },
  { key: "gender", label: "מין" },
  { key: "birthDate", label: "תאריך לידה" },
  { key: "age", label: "גיל" },
  { key: "tz", label: "ת.ז." },
  { key: "email", label: "אימייל" },
  { key: "email2", label: "אימייל 2" },
  { key: "phone", label: "נייד" },
  { key: "phone2", label: "נייד 2" },
  { key: "address", label: "כתובת" },
  { key: "city", label: "עיר" },
  { key: "status", label: "סטטוס סטודנט" },
  { key: "active", label: "פעיל" },
  { key: "maritalStatus", label: "מצב משפחתי" },
  { key: "hasChildren", label: "ילדים" },
  { key: "framework", label: "מסגרת" },
  { key: "residenceType", label: "מקום מגורים" },
  { key: "emergencyContact", label: "איש קשר חירום" },
  { key: "emergencyPhone", label: "טלפון חירום" },
  { key: "notes", label: "הערות" },
];

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records) {
  const lines = [HEADERS.map((h) => csvEscape(h.label)).join(",")];
  for (const rec of records) {
    lines.push(HEADERS.map((h) => csvEscape(rec[h.key])).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM + CRLF
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const html = fs.readFileSync(SOURCE, "utf8");
const rows = parseTable(html).slice(1); // drop header
const collegeRows = rows.filter((r) => r[2] && r[2].includes("מכללה לכל"));
const records = collegeRows.map(rowToStudent);

// De-duplicate by id (the source has a few repeated rows)
const seen = new Set();
const unique = records.filter((r) => {
  if (seen.has(r.id)) return false;
  seen.add(r.id);
  return true;
});

fs.writeFileSync(OUTPUT, toCsv(unique), "utf8");
console.log(`✅ Wrote ${unique.length} students to ${OUTPUT}`);
console.log(`   (filtered ${collegeRows.length - unique.length} duplicates)`);
