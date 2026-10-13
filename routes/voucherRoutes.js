/**
 * @file Voucher routes - /api/vouchers (תרבות לכל)
 * @module routes/voucherRoutes
 * @see controllers/voucherController
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/voucherController");

router.route("/").get(c.getVouchers).post(c.createVoucher);
router.get("/image-search", c.searchImages); // before /:id
router.get("/image-fetch", c.fetchImage); // the bytes of a picture on the web, for the browser to square
router.route("/:id/image").get(c.getImage).patch(c.setImage);
router.route("/:id").get(c.getVoucherById).put(c.updateVoucher).delete(c.deleteVoucher);
router.post("/:id/grant", c.grantVoucher);
router.post("/:id/redeem", c.redeemVoucher);
router.post("/:id/revoke", c.revokeGrant);

module.exports = router;
