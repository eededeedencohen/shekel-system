/**
 * @file authService - signing in, sessions, passwords, the staff accounts
 * @module services/authService
 *
 * Eden (2026-10-12): every staff member signs in with an English user name
 * and a password. The first account is the super admin (eden), who manages
 * the others on the users page and sends a reset link on WhatsApp; anyone
 * can change their own password, and "שכחתי סיסמה" on the sign-in page
 * flags the account for the super admin.
 *
 * Default password = the user name with its last letter in capitals + "!@#"
 * (utils/password defaultPasswordFor). The six accounts the app had as
 * personas are created on the first boot that finds the table empty.
 */

const StaffAccount = require("../models/StaffAccount");
const StaffSession = require("../models/StaffSession");
const PasswordReset = require("../models/PasswordReset");
const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const { STAFF_KIND_KEYS, RESET_LINK_HOURS } = require("../utils/domain");
const { hashPassword, verifyPassword, defaultPasswordFor, isStrongEnough, newToken, hashToken, isTokenShape } = require("../utils/password");

const DAY = 86400000;
const SESSION_DAYS = 30;
const CACHE_MS = 30 * 1000;

/** The staff the app knew as personas ("צפה בתור") before there were passwords. */
const SEED_ACCOUNTS = [
  { username: "eden", name: "עדן כהן", title: "סופר-מנהל", kind: "super" },
  { username: "hagai", name: "חגי", title: "מנהל מכללה", kind: "manager" },
  { username: "noa", name: "נעה", title: "מנהלת מכללה", kind: "manager" },
  { username: "yetav", name: "ייטב", title: 'עו"ס', kind: "social" },
  { username: "tamar", name: "תמר צימרינג", title: "רכזת הוסטלים", kind: "hostels" },
  { username: "shiran", name: "שירן דרעי", title: "רכזת תרבות לכל", kind: "culture" },
];

/** First boot with an empty table: the six accounts, each with its default password. */
async function ensureSeedAccounts() {
  if (await StaffAccount.estimatedDocumentCount()) return 0;
  for (const a of SEED_ACCOUNTS) {
    await StaffAccount.create({ ...a, passwordHash: await hashPassword(defaultPasswordFor(a.username)) });
  }
  return SEED_ACCOUNTS.length;
}

/* ───────── sessions ───────── */

const cache = new Map(); // tokenHash → { account, until }
const forget = () => cache.clear();

/** What the browser learns about the signed-in account. */
const publicAccount = (a) => ({
  _id: String(a._id),
  username: a.username,
  name: a.name,
  title: a.title || "",
  kind: a.kind,
  phone: a.phone || "",
  email: a.email || "",
  /** The staff member's own Person row, when linked (the users page) - the actor's person id on the server (utils/actor). */
  person: a.person ? String(a.person) : null,
  defaultPassword: !a.passwordChangedAt,
});

async function openSession(account, userAgent) {
  const token = newToken();
  await StaffSession.create({
    account: account._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_DAYS * DAY),
    userAgent: String(userAgent || "").slice(0, 300),
  });
  return token;
}

/** The account a session token belongs to (null when signed out / expired / disabled). */
async function accountForToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return hit.account;
  const session = await StaffSession.findOne({ tokenHash: h }).lean();
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    cache.delete(h);
    return null;
  }
  const account = await StaffAccount.findById(session.account).lean();
  if (!account || !account.active) return null;
  // sliding expiry: a session in use keeps living (at most one write an hour)
  if (Date.now() - new Date(session.lastSeenAt).getTime() > 3600 * 1000) {
    StaffSession.updateOne({ _id: session._id }, { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) }).catch(() => {});
  }
  cache.set(h, { account, until: Date.now() + CACHE_MS });
  return account;
}

/** A borrowed lens (utils/auth actorOf): the account by id, briefly cached like a session. */
async function accountById(id) {
  if (!/^[0-9a-f]{24}$/i.test(String(id))) return null;
  const key = "id:" + id;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.account;
  const account = await StaffAccount.findById(id).lean();
  cache.set(key, { account, until: Date.now() + CACHE_MS });
  return account;
}

async function endSession(token) {
  if (!token) return;
  const h = hashToken(token);
  cache.delete(h);
  await StaffSession.deleteOne({ tokenHash: h });
}

/** Every session of an account ends (a new password, a disabled account) - except `keepToken`'s. */
async function endSessionsOf(accountId, keepToken) {
  const filter = { account: accountId };
  if (keepToken) filter.tokenHash = { $ne: hashToken(keepToken) };
  await StaffSession.deleteMany(filter);
  forget();
}

/* ───────── signing in ───────── */

// Five wrong passwords for one user name from one address → five minutes' rest.
const attempts = new Map(); // `${ip}|${username}` → { fails, first, lockedUntil }
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
let dummyHash = null; // compared against when the user name is unknown (same timing)

async function login({ username, password, ip, userAgent }) {
  const u = String(username || "").trim().toLowerCase();
  const key = `${ip || ""}|${u}`;
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && rec.lockedUntil > now) throw AppError.of("AUTH_LOCKED", 429);

  const account = u ? await StaffAccount.findOne({ username: u }).select("+passwordHash") : null;
  if (!dummyHash) dummyHash = await hashPassword(newToken());
  const ok = await verifyPassword(String(password || ""), account ? account.passwordHash : dummyHash);
  if (!account || !ok || !account.active) {
    const r = rec && now - rec.first < WINDOW_MS ? rec : { fails: 0, first: now, lockedUntil: 0 };
    r.fails += 1;
    if (r.fails >= MAX_FAILS) {
      r.lockedUntil = now + LOCK_MS;
      r.fails = 0;
      r.first = now;
    }
    attempts.set(key, r);
    throw AppError.of("AUTH_FAILED", 401);
  }
  attempts.delete(key);
  account.lastLoginAt = new Date();
  await account.save();
  const token = await openSession(account, userAgent);
  return { account: publicAccount(account), token };
}

async function changePassword(accountId, { current, next }, keepToken) {
  const account = await StaffAccount.findById(accountId).select("+passwordHash");
  if (!account) throw AppError.of("AUTH_REQUIRED", 401);
  if (!(await verifyPassword(String(current || ""), account.passwordHash))) throw AppError.of("PASSWORD_WRONG", 400);
  if (!isStrongEnough(next)) throw AppError.of("PASSWORD_WEAK", 400);
  account.passwordHash = await hashPassword(next);
  account.passwordChangedAt = new Date();
  account.resetRequestedAt = null;
  await account.save();
  await endSessionsOf(account._id, keepToken); // other browsers sign in again
  return publicAccount(account);
}

/** "שכחתי סיסמה": flags the account for the super admin. Says nothing about whether it exists. */
async function requestReset(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return;
  await StaffAccount.updateOne({ username: u, active: true }, { resetRequestedAt: new Date() });
}

/* ───────── reset links ───────── */

async function liveReset(token) {
  if (!isTokenShape(token)) throw AppError.of("RESET_INVALID", 404);
  const reset = await PasswordReset.findOne({ tokenHash: hashToken(token) });
  if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) throw AppError.of("RESET_INVALID", 404);
  const account = await StaffAccount.findById(reset.account).select("+passwordHash");
  if (!account || !account.active) throw AppError.of("RESET_INVALID", 404);
  return { reset, account };
}

/** What the reset page shows before the new password is typed. */
async function resetInfo(token) {
  const { reset, account } = await liveReset(token);
  return { name: account.name, username: account.username, expiresAt: reset.expiresAt };
}

/** A new password through the link: every session ends, this browser is signed in. */
async function resetPassword(token, password, userAgent) {
  const { reset, account } = await liveReset(token);
  if (!isStrongEnough(password)) throw AppError.of("PASSWORD_WEAK", 400);
  account.passwordHash = await hashPassword(password);
  account.passwordChangedAt = new Date();
  account.resetRequestedAt = null;
  account.lastLoginAt = new Date();
  await account.save();
  reset.usedAt = new Date();
  await reset.save();
  // any other open link of this account is spent too
  await PasswordReset.updateMany({ account: account._id, usedAt: null }, { usedAt: new Date() });
  await endSessionsOf(account._id);
  const session = await openSession(account, userAgent);
  return { account: publicAccount(account), token: session };
}

/* ───────── the users page (super admin) ───────── */

const adminView = (a) => ({
  ...publicAccount(a),
  active: a.active !== false,
  lastLoginAt: a.lastLoginAt || null,
  passwordChangedAt: a.passwordChangedAt || null,
  resetRequestedAt: a.resetRequestedAt || null,
  createdAt: a.createdAt,
});

async function listAccounts() {
  const rows = await StaffAccount.find().sort({ createdAt: 1 }).lean();
  return rows.map(adminView);
}

/** The names the app offers in its staff pickers (any signed-in user). */
async function staffDirectory() {
  const rows = await StaffAccount.find({ active: true }).sort({ createdAt: 1 }).select("name title kind").lean();
  return rows.map((a) => ({ _id: String(a._id), name: a.name, title: a.title || "", kind: a.kind }));
}

const FIELDS = ["username", "name", "title", "kind", "phone", "email", "active", "person"];
const pick = (body) => Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, typeof body[k] === "string" ? body[k].trim() : body[k]]));

function validate(fields, creating) {
  if (fields.username !== undefined) fields.username = String(fields.username).toLowerCase();
  if (fields.active !== undefined) fields.active = Boolean(fields.active);
  const need = creating ? ["username", "name", "kind"] : [];
  if (need.some((k) => !fields[k])) throw AppError.of("ACCOUNT_INVALID", 400);
  if (fields.username !== undefined && !/^[a-z][a-z0-9._-]{1,31}$/.test(fields.username)) throw AppError.of("ACCOUNT_INVALID", 400, "שם המשתמש - אותיות באנגלית");
  if (fields.name !== undefined && !fields.name) throw AppError.of("ACCOUNT_INVALID", 400);
  if (fields.kind !== undefined && !STAFF_KIND_KEYS.includes(fields.kind)) throw AppError.of("ACCOUNT_INVALID", 400);
  return fields;
}

/** The optional link to a Person row: empty clears it, else a live person (2026-10-26). */
async function resolvePerson(fields) {
  if (fields.person === undefined) return fields;
  if (!fields.person) return { ...fields, person: null };
  if (!mongoose.isValidObjectId(fields.person) || !(await Person.exists({ _id: fields.person, deletedAt: null }))) throw AppError.of("ACCOUNT_INVALID", 400, "האדם לא נמצא");
  return fields;
}

const taken = (err) => {
  if (err && err.code === 11000) throw AppError.of("USERNAME_TAKEN", 409);
  throw err;
};

/** A new account starts with its default password. */
async function createAccount(body) {
  const fields = await resolvePerson(validate(pick(body), true));
  const account = await StaffAccount.create({ ...fields, passwordHash: await hashPassword(defaultPasswordFor(fields.username)) }).catch(taken);
  return adminView(account.toObject());
}

async function updateAccount(id, body) {
  const fields = await resolvePerson(validate(pick(body), false));
  const account = await StaffAccount.findById(id);
  if (!account) throw new AppError("המשתמש לא נמצא", 404);
  const wasSuper = account.active && account.kind === "super";
  const staysSuper = (fields.active ?? account.active) && (fields.kind ?? account.kind) === "super";
  if (wasSuper && !staysSuper) {
    const others = await StaffAccount.countDocuments({ _id: { $ne: account._id }, kind: "super", active: true });
    if (!others) throw AppError.of("LAST_SUPER", 409);
  }
  // a user name change keeps the password; the default-password flag says what it was made from
  Object.assign(account, fields);
  await account.save().catch(taken);
  if (fields.active === false) await endSessionsOf(account._id);
  forget();
  return adminView(account.toObject());
}

/** The super admin's "איפוס סיסמה": the browser made the token (the WhatsApp text is ready at once). */
async function createResetLink(id, token, createdBy) {
  if (!isTokenShape(token)) throw AppError.of("RESET_INVALID", 400);
  const account = await StaffAccount.findById(id);
  if (!account) throw new AppError("המשתמש לא נמצא", 404);
  const tokenHash = hashToken(token);
  // the same token twice (a retry, React's double effect) is the same link
  const same = await PasswordReset.findOne({ tokenHash }).lean();
  if (same) {
    if (String(same.account) !== String(account._id)) throw AppError.of("RESET_INVALID", 400);
    return { expiresAt: same.expiresAt };
  }
  const expiresAt = new Date(Date.now() + RESET_LINK_HOURS * 3600 * 1000);
  await PasswordReset.create({ account: account._id, tokenHash, expiresAt, createdBy: String(createdBy || "") });
  return { expiresAt };
}

module.exports = {
  SEED_ACCOUNTS,
  ensureSeedAccounts,
  publicAccount,
  accountForToken,
  accountById,
  endSession,
  login,
  changePassword,
  requestReset,
  resetInfo,
  resetPassword,
  listAccounts,
  staffDirectory,
  createAccount,
  updateAccount,
  createResetLink,
};
