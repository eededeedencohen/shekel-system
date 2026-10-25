/**
 * @file Voucher controller - the תרבות לכל voucher stock and who holds what
 * @module controllers/voucherController
 * @see services/cultureService
 */

const Voucher = require("../models/Voucher");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const culture = require("../services/cultureService");
const voucherImages = require("../services/voucherImageService");
const { notModified } = require("../utils/sendFile");

const POP = [
  { path: "grant.student", select: "firstName lastName avatar" },
  { path: "grant.by", select: "firstName lastName" },
];

/** GET /api/vouchers?student=&available=true&redeemed=false */
exports.getVouchers = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.student) filter["grant.student"] = req.query.student;
  if (req.query.available === "true") filter.grant = null;
  if (req.query.redeemed === "true") filter["grant.redeemed"] = true;
  if (req.query.redeemed === "false") filter["grant.redeemed"] = { $ne: true };
  const vouchers = await Voucher.find(filter).populate(POP).sort({ name: 1, number: 1 });
  res.status(200).json({ status: "success", results: vouchers.length, data: { vouchers } });
});

exports.getVoucherById = catchAsync(async (req, res, next) => {
  const voucher = await Voucher.findById(req.params.id).populate(POP);
  if (!voucher) return next(AppError.of("NOT_FOUND", 404, "שובר"));
  res.status(200).json({ status: "success", data: { voucher } });
});

/** POST /api/vouchers - body { by*, name*, number*, balance|initialValue, expiresAt?, notes?, + the picture: imageData(+imageThumb, imageName) | imageUrl | imageFrom } */
exports.createVoucher = catchAsync(async (req, res, next) => {
  if (!req.body.name || !req.body.number) return next(AppError.of("MISSING_FIELDS", 400, "name, number"));
  const voucher = await culture.createVoucher({ by: req.body.by, data: req.body });
  res.status(201).json({ status: "success", data: { voucher } });
});

/** PUT /api/vouchers/:id - body { by*, …fields } */
exports.updateVoucher = catchAsync(async (req, res) => {
  const voucher = await culture.updateVoucher({ voucherId: req.params.id, by: req.body.by, data: req.body });
  res.status(200).json({ status: "success", data: { voucher } });
});

/** POST /api/vouchers/:id/grant - body { by*, student*, note? } */
exports.grantVoucher = catchAsync(async (req, res, next) => {
  if (!req.body.student) return next(AppError.of("MISSING_FIELDS", 400, "student"));
  const voucher = await culture.grantVoucher({
    voucherId: req.params.id, by: req.body.by, studentId: req.body.student, note: req.body.note,
  });
  res.status(200).json({ status: "success", data: { voucher: await voucher.populate(POP) } });
});

/** POST /api/vouchers/:id/redeem - body { by* } */
exports.redeemVoucher = catchAsync(async (req, res) => {
  const voucher = await culture.redeemVoucher({ voucherId: req.params.id, by: req.body.by });
  res.status(200).json({ status: "success", data: { voucher: await voucher.populate(POP) } });
});

/** POST /api/vouchers/:id/revoke - body { by* } - un-redeemed grants only */
exports.revokeGrant = catchAsync(async (req, res) => {
  const voucher = await culture.revokeGrant({ voucherId: req.params.id, by: req.body.by });
  res.status(200).json({ status: "success", data: { voucher } });
});

/** GET /api/vouchers/image-search?q= - pictures on the web for a place name (Wikipedia) */
exports.searchImages = catchAsync(async (req, res) => {
  const images = await culture.searchVoucherImages(req.query.q);
  res.status(200).json({ status: "success", results: images.length, data: { images } });
});

/**
 * GET /api/vouchers/image-fetch?url= - the bytes of a picture on the web
 * (a picture's own address, or a page whose og:image is one), so the
 * browser can square it before saving (Eden, 2026-10-13: every picture is
 * 1:1; most sites refuse a cross-origin fetch from the browser itself).
 */
exports.fetchImage = catchAsync(async (req, res, next) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//i.test(url)) return next(AppError.of("VOUCHER_IMAGE_FETCH", 422));
  const got = await voucherImages.fetchImage(url).catch(() => null);
  if (!got) return next(AppError.of("VOUCHER_IMAGE_FETCH", 422));
  res.set("Cache-Control", "private, max-age=600");
  res.type(got.mime).send(got.buffer);
});

/** GET /api/vouchers/:id/image[?thumb=1] - the picture of the place (a plain link) */
exports.getImage = catchAsync(async (req, res, next) => {
  const got = await culture.voucherImageOf(req.params.id, req.query.thumb === "1");
  if (!got) return next(AppError.of("NOT_FOUND", 404, "תמונת השובר"));
  if (notModified(req, res, got.tag)) return;
  res.type(got.mime).send(got.data);
});

/** PATCH /api/vouchers/:id/image - body { by*, imageData(+imageThumb, imageName) | imageUrl | imageFrom | remove: true } */
exports.setImage = catchAsync(async (req, res) => {
  const voucher = await culture.setVoucherImage({ voucherId: req.params.id, by: req.body.by, data: req.body });
  res.status(200).json({ status: "success", data: { voucher: await voucher.populate(POP) } });
});

/** DELETE /api/vouchers/:id?by= - never-granted vouchers only */
exports.deleteVoucher = catchAsync(async (req, res) => {
  await culture.deleteVoucher({ voucherId: req.params.id, by: req.query.by || req.body?.by });
  res.status(204).json({ status: "success", data: null });
});
