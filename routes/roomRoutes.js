/**
 * @file Room routes
 * @module routes/roomRoutes
 * @see controllers/roomController
 */

const express = require("express");
const router = express.Router();
const {
  getRooms,
  getRoomById,
  createRoom,
  updateRoom,
  deleteRoom,
} = require("../controllers/roomController");

router.route("/").get(getRooms).post(createRoom);
router.route("/:id").get(getRoomById).put(updateRoom).delete(deleteRoom);

module.exports = router;
