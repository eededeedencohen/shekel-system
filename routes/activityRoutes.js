/**
 * @file Activity routes - a person's record and the templates
 * @module routes/activityRoutes
 * @see controllers/activityController
 */

const express = require("express");
const router = express.Router();
const {
  getActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  getTemplates,
  getTemplate,
  saveTemplate,
  resetTemplate,
} = require("../controllers/activityController");
const Activity = require("../models/Activity");
const lens = require("../services/lensService");

// a row is reachable only when its person is in the acting persona's lens (services/lensService)
router.param("id", lens.guardByPerson(Activity));

// Static paths before /:id
router.get("/templates", getTemplates);
router.route("/templates/:kind").get(getTemplate).put(saveTemplate).delete(resetTemplate);

router.route("/").get(getActivities).post(createActivity);
router.route("/:id").patch(updateActivity).delete(deleteActivity);

module.exports = router;
