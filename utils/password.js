/**
 * @file password - hashing and tokens (Node's crypto only, no extra package)
 * @module utils/password
 *
 * Passwords: scrypt with a random 16-byte salt, stored as
 * "scrypt$<salt>$<hash>" (base64), compared in constant time.
 * Tokens (sessions, reset links): 32 random bytes as base64url; the
 * database keeps only their SHA-256.
 */

const crypto = require("crypto");

const KEYLEN = 64;
const MIN_LENGTH = 6;

const scrypt = (password, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltB64, keyB64] = String(stored || "").split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(String(password), Buffer.from(saltB64, "base64"));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Eden's default: the user name with its last letter in capitals + "!@#" ("eden" → "edeN!@#"). */
const defaultPasswordFor = (username) => {
  const u = String(username || "");
  return `${u.slice(0, -1)}${u.slice(-1).toUpperCase()}!@#`;
};

const isStrongEnough = (password) => typeof password === "string" && password.length >= MIN_LENGTH && password.length <= 200;

const newToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
/** A token the browser made: base64url, at least 32 characters. */
const isTokenShape = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(token);

module.exports = { hashPassword, verifyPassword, defaultPasswordFor, isStrongEnough, newToken, hashToken, isTokenShape, MIN_LENGTH };
