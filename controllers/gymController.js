/**
 * @file Gym controller - חדר כושר פרופיט
 * @module controllers/gymController
 *
 * /api/gym (the "gym" grant, utils/auth requireFeature):
 *   GET  /                 every member the lens sees
 *   POST /                 { person } or { firstName, lastName, gender, phone, notes } → 201 { membership, revived }
 *   GET|PATCH|DELETE /:id  one member; PATCH { notes, contract: { name, idNumber } }; DELETE = leaves the program
 *   POST /:id/membership   { membership, note }
 *   POST /:id/sent         the link went out on WhatsApp
 *   GET|POST /:id/link     the signing link, whole (POST = a fresh token)
 *   GET  /:id/signature    302 to the signature PNG
 * /api/public/gym/:token (no login - the member's own signing page):
 *   GET  /                 { name, phone, gender, signed, signedAt, idNumber, hasSignature }
 *   POST /sign             { name, idNumber, phone, signature (a PNG data URL) }
 *   GET  /signature        302 to the signature PNG
 */

const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const gym = require("../services/gymService");
const { byOf } = require("../utils/actor");

const ok = (res, data, code = 200) => res.status(code).json({ status: "success", data });

exports.list = catchAsync(async (req, res) => ok(res, { memberships: await gym.list(req) }));

exports.add = catchAsync(async (req, res) => {
  const b = req.body || {};
  const { membership, revived } = await gym.add(req, { person: b.person, firstName: b.firstName, lastName: b.lastName, gender: b.gender, phone: b.phone, notes: b.notes, by: byOf(req) });
  ok(res, { membership, revived }, 201);
});

exports.get = catchAsync(async (req, res) => ok(res, { membership: await gym.load(req.params.id) }));

exports.update = catchAsync(async (req, res) => {
  const b = req.body || {};
  ok(res, { membership: await gym.update(req.params.id, { notes: b.notes, contract: b.contract, by: byOf(req) }) });
});

exports.setMembership = catchAsync(async (req, res) => {
  const b = req.body || {};
  ok(res, { membership: await gym.setMembership(req.params.id, { membership: b.membership, note: b.note, by: byOf(req) }) });
});

exports.markSent = catchAsync(async (req, res) => ok(res, { membership: await gym.markSent(req.params.id, byOf(req)) }));

exports.getLink = catchAsync(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  ok(res, { link: await gym.link(req, req.params.id) });
});

exports.renewLink = catchAsync(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  ok(res, { link: await gym.renewLink(req, req.params.id, byOf(req)) });
});

exports.remove = catchAsync(async (req, res) => {
  await gym.remove(req.params.id, byOf(req));
  res.status(204).end();
});

exports.signature = catchAsync(async (req, res, next) => {
  const GymMembership = require("../models/GymMembership");
  const m = await GymMembership.findById(req.params.id).select("contract").lean();
  const url = m && (await gym.signatureUrl(m));
  if (!url) return next(AppError.of("NOT_FOUND", 404, "חתימה"));
  res.set("Cache-Control", "private, no-store");
  res.redirect(302, url);
});

/* ───────── the public signing page ───────── */

exports.publicView = catchAsync(async (req, res) => ok(res, { contract: gym.publicView(await gym.byToken(req.params.token)) }));

exports.publicSign = catchAsync(async (req, res) => {
  const b = req.body || {};
  ok(res, { contract: await gym.sign(req.params.token, { name: b.name, idNumber: b.idNumber, phone: b.phone, signature: b.signature }) });
});

exports.publicSignature = catchAsync(async (req, res, next) => {
  const m = await gym.byToken(req.params.token);
  const url = await gym.signatureUrl(m);
  if (!url) return next(AppError.of("NOT_FOUND", 404, "חתימה"));
  res.set("Cache-Control", "private, no-store");
  res.redirect(302, url);
});
