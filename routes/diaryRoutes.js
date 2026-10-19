/**
 * @file Diary routes - the acting account's own notes and tasks.
 * Mounted at /api/diary; every staff kind has a diary.
 * @module routes/diaryRoutes
 */

const express = require("express");
const router = express.Router();
const c = require("../controllers/diaryController");

router.route("/").get(c.list).post(c.create);
router.route("/:id").patch(c.update).delete(c.remove);

module.exports = router;
