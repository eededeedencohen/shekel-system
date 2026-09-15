/**
 * @file Voucher controller — the תרבות לכל voucher stock and who holds what
 * @module controllers/voucherController
 * @see services/cultureService
 */

const Voucher = require("../models/Voucher");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const culture = require("../services/cultureService");

const POP = [
  { path: "grant.student", select: "firstName lastName avatar" },
  { path: "grant.by", select: "firstName lastName" },
];

/** GET /api/vouchers?student=&available=true&redeemed=false */
exports.getVouchers = catchAsync(async (req, res) => {
  const filter = { world: req.world };
  if (req.query.student) filter["grant.student"] = req.query.student;
  if (req.query.available === "true") filter.grant = null;
  if (req.query.redeemed === "true") filter["grant.redeemed"] = true;
  if (req.query.redeemed === "false") filter["grant.redeemed"] = { $ne: true };
  const vouchers = await Voucher.find(filter).populate(POP).sort({ name: 1, number: 1 });
  res.status(200).json({ status: "success", results: vouchers.length, data: { vouchers } });
});

exports.getVoucherById = catchAsync(async (req, res, next) => {
  const voucher = await Voucher.findOne({ _id: req.params.id, world: req.world }).populate(POP);
  if (!voucher) return next(AppError.of("NOT_FOUND", 404, "שובר"));
  res.status(200).json({ status: "success", data: { voucher } });
});

/** POST /api/vouchers — body { by*, name*, number*, balance|initialValue, expiresAt?, notes? } */
exports.createVoucher = catchAsync(async (req, res, next) => {
  if (!req.body.name || !req.body.number) return next(AppError.of("MISSING_FIELDS", 400, "name, number"));
  const voucher = await culture.createVoucher({ world: req.world, by: req.body.by, data: req.body });
  res.status(201).json({ status: "success", data: { voucher } });
});

/** PUT /api/vouchers/:id — body { by*, …fields } */
exports.updateVoucher = catchAsync(async (req, res) => {
  const voucher = await culture.updateVoucher({ voucherId: req.params.id, world: req.world, by: req.body.by, data: req.body });
  res.status(200).json({ status: "success", data: { voucher } });
});

/** POST /api/vouchers/:id/grant — body { by*, student*, note? } */
exports.grantVoucher = catchAsync(async (req, res, next) => {
  if (!req.body.student) return next(AppError.of("MISSING_FIELDS", 400, "student"));
  const voucher = await culture.grantVoucher({
    voucherId: req.params.id, world: req.world, by: req.body.by, studentId: req.body.student, note: req.body.note,
  });
  res.status(200).json({ status: "success", data: { voucher: await voucher.populate(POP) } });
});

/** POST /api/vouchers/:id/redeem — body { by* } */
exports.redeemVoucher = catchAsync(async (req, res) => {
  const voucher = await culture.redeemVoucher({ voucherId: req.params.id, world: req.world, by: req.body.by });
  res.status(200).json({ status: "success", data: { voucher: await voucher.populate(POP) } });
});

/** POST /api/vouchers/:id/revoke — body { by* } — un-redeemed grants only */
exports.revokeGrant = catchAsync(async (req, res) => {
  const voucher = await culture.revokeGrant({ voucherId: req.params.id, world: req.world, by: req.body.by });
  res.status(200).json({ status: "success", data: { voucher } });
});

/** DELETE /api/vouchers/:id?by= — never-granted vouchers only */
exports.deleteVoucher = catchAsync(async (req, res) => {
  await culture.deleteVoucher({ voucherId: req.params.id, world: req.world, by: req.query.by || req.body?.by });
  res.status(204).json({ status: "success", data: null });
});
