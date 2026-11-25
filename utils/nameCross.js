/**
 * @file nameCross - who of a list is the same person as who of ours
 * @module utils/nameCross
 *
 * The server's twin of the client's lib/crossCheck.js (the ideas page's
 * cross-check tab, the super admin's). The "putting in order" pages lay the
 * old system's students beside ours for the college's staff too, and there
 * the match is made HERE, so that no phone and no ID number of the lists
 * travels to a page for the sake of a comparison. The two files must agree:
 * a rule changed in one is changed in the other.
 *
 * WHO IS THE SAME PERSON - from the surest sign down:
 *   id      the same ID number (`row.idPerson`, said by whoever read the numbers)
 *   phone   the same mobile AND a name that agrees
 *   name    the same name, word for word in any order, carried by one on each side
 * and what is only LIKELY, left for a person to decide:
 *   phoneOnly  the same mobile under a different name
 *   nameClose  a name one letter away, or one name inside the other
 *   nameMany   a name that fits more than one person
 */

const FINALS = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/** A name as it is compared: no points and marks, final letters as plain ones, one space. */
function nameWords(v) {
  const s = String(v || "")
    .normalize("NFKC")
    .replace(/[֑-ׇ]/g, "")
    .replace(/[׳'`´’"״]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .toLowerCase()
    .trim();
  return s ? s.split(" ").filter(Boolean) : [];
}
const nameKey = (v) => nameWords(v).slice().sort().join(" ");

/** A phone as it is compared: its digits, an Israeli number led by 0. "" for none. */
function phoneKey(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return d.length >= 9 ? d : "";
}

/** One letter added, dropped or changed. */
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let x = a.length - 1;
  let y = b.length - 1;
  while (x >= i && y >= i && a[x] === b[y]) {
    x--;
    y--;
  }
  return Math.max(x - i, y - i) < 1;
}

/** "same" (the same words, any order) · "close" (one word a letter away, or the shorter name inside the longer) · "". */
function nameFit(aWords, bWords) {
  if (!aWords.length || !bWords.length) return "";
  const a = aWords.slice().sort();
  const b = bWords.slice().sort();
  if (a.join(" ") === b.join(" ")) return "same";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && short.every((w) => long.includes(w))) return "close";
  if (a.length === b.length && a.length >= 2) {
    const left = b.slice();
    let off = 0;
    for (const w of a) {
      let k = left.indexOf(w);
      if (k < 0) {
        k = left.findIndex((x) => near(w, x));
        off++;
      }
      if (k < 0) return "";
      left.splice(k, 1);
    }
    if (off <= 1) return "close";
  }
  return "";
}

const fullName = (p) => (p.name != null ? String(p.name) : `${p.firstName || ""} ${p.lastName || ""}`.trim());

/**
 * The cross: `rows` ({ rid, name, phone, idPerson }) beside `people` ({ _id, firstName, lastName, phone }).
 *   pairs    [{ row, person, how }]   the same person, surely
 *   check    [{ row, person, why }]   likely the same - a person decides
 *   onlyOld  [row]                    in the list alone
 *   onlyOurs [person]                 ours alone
 * Each row and each person is used once: the sure signs take first, then the likely ones.
 */
function crossCheck(rows, people) {
  const R = (rows || []).map((row) => ({ row, words: nameWords(row.name), phone: phoneKey(row.phone) }));
  const P = (people || []).map((person) => ({ person, id: String(person._id), words: nameWords(fullName(person)), phone: phoneKey(person.phone) }));
  for (const x of R) x.key = x.words.slice().sort().join(" ");
  for (const x of P) x.key = x.words.slice().sort().join(" ");

  const takenR = new Set();
  const takenP = new Set();
  const pairs = [];
  const check = [];
  const take = (list, r, p, extra) => {
    takenR.add(r);
    takenP.add(p);
    list.push({ row: r.row, person: p.person, ...extra });
  };
  const freeP = () => P.filter((p) => !takenP.has(p));
  const freeR = () => R.filter((r) => !takenR.has(r));

  // 1. the same ID number
  const byId = new Map(P.map((p) => [p.id, p]));
  for (const r of R) {
    const p = r.row.idPerson ? byId.get(String(r.row.idPerson)) : null;
    if (p && !takenP.has(p)) take(pairs, r, p, { how: "id" });
  }

  // 2. the same phone and a name that agrees
  const byPhone = (list) => {
    const m = new Map();
    for (const x of list) if (x.phone) m.set(x.phone, [...(m.get(x.phone) || []), x]);
    return m;
  };
  let phones = byPhone(freeP());
  for (const r of freeR()) {
    if (!r.phone) continue;
    const p = (phones.get(r.phone) || []).find((x) => !takenP.has(x) && nameFit(r.words, x.words));
    if (p) take(pairs, r, p, { how: "phone" });
  }

  // 3. the same name, carried by one on each side
  const count = (list) => {
    const m = new Map();
    for (const x of list) if (x.key) m.set(x.key, (m.get(x.key) || 0) + 1);
    return m;
  };
  const rNames = count(freeR());
  const pNames = count(freeP());
  const pByName = new Map(freeP().map((p) => [p.key, p]));
  for (const r of freeR()) {
    if (!r.key || rNames.get(r.key) !== 1 || pNames.get(r.key) !== 1) continue;
    take(pairs, r, pByName.get(r.key), { how: "name" });
  }

  // 4. likely: a name that fits more than one · the same phone under another name · a name a little different
  for (const r of freeR()) {
    if (!r.key) continue;
    const p = freeP().find((x) => x.key === r.key);
    if (p) take(check, r, p, { why: "nameMany" });
  }
  phones = byPhone(freeP());
  for (const r of freeR()) {
    if (!r.phone) continue;
    const p = (phones.get(r.phone) || []).find((x) => !takenP.has(x));
    if (p) take(check, r, p, { why: "phoneOnly" });
  }
  for (const r of freeR()) {
    if (r.words.length < 2) continue;
    const fits = freeP().filter((x) => nameFit(r.words, x.words) === "close");
    if (fits.length === 1) take(check, r, fits[0], { why: "nameClose" });
  }

  return { pairs, check, onlyOld: freeR().map((r) => r.row), onlyOurs: freeP().map((p) => p.person) };
}

module.exports = { nameWords, nameKey, phoneKey, nameFit, crossCheck };
