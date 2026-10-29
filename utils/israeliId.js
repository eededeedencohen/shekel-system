/**
 * @file israeliId - the check digit of an Israeli ID number
 * @module utils/israeliId
 *
 * Nine digits (shorter numbers are padded with zeros on the left); the
 * digits are weighted 1,2,1,2,…, a product above 9 adds its two digits,
 * and the sum must divide by 10. The gym contract takes the number as
 * typed and refuses a typo at the door (the old app checked the length
 * alone).
 */

function normalizeIsraeliId(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits || digits.length > 9) return "";
  return digits.padStart(9, "0");
}

function isValidIsraeliId(value) {
  const id = normalizeIsraeliId(value);
  if (id.length !== 9 || /^0+$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

module.exports = { normalizeIsraeliId, isValidIsraeliId };
