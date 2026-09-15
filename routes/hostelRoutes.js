/**
 * @file Hostel routes
 * @module routes/hostelRoutes
 * @see controllers/hostelController
 */

const express = require("express");
const router = express.Router();
const {
  getHostels,
  createHostel,
  updateHostel,
  deleteHostel,
} = require("../controllers/hostelController");

router.route("/").get(getHostels).post(createHostel);
router.route("/:id").put(updateHostel).delete(deleteHostel);

module.exports = router;
