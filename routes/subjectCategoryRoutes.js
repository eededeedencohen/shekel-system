/**
 * @file Subject-category routes
 * @module routes/subjectCategoryRoutes
 * @see controllers/subjectCategoryController
 */

const express = require("express");
const router = express.Router();
const { list, create, update, remove } = require("../controllers/subjectCategoryController");

router.route("/").get(list).post(create);
router.route("/:id").put(update).delete(remove);

module.exports = router;
