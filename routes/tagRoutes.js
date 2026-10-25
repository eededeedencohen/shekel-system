/**
 * @file Tag routes - /api/tags: the catalog of belongings
 * @module routes/tagRoutes
 */

const express = require("express");
const router = express.Router();
const catchAsync = require("../utils/catchAsync");
const tags = require("../services/tagService");
const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const lens = require("../services/lensService");

// the person must be in the acting persona's lens (services/lensService)
router.param("id", lens.guardPerson);

/** GET /api/tags → { groups: [{key,label}], tags: [{key,label,group,active}] } */
router.get(
  "/",
  catchAsync(async (req, res) => {
    const data = await tags.catalog();
    res.status(200).json({ status: "success", data });
  })
);

/** POST /api/tags/people/:id - { key*, by, note } → the person's tags now */
router.post(
  "/people/:id",
  catchAsync(async (req, res) => {
    const person = await requirePerson(req.params.id);
    lens.assertProgramTag(req, req.body.key); // a program tag of the persona's own program only
    await tags.give({ personId: person._id, key: req.body.key, by: req.body.by, note: req.body.note });
    res.status(200).json({ status: "success", data: await answer(person._id) });
  })
);

/** DELETE /api/tags/people/:id/:key - { by, note } → the person's tags now */
router.delete(
  "/people/:id/:key",
  catchAsync(async (req, res) => {
    const person = await requirePerson(req.params.id);
    lens.assertProgramTag(req, req.params.key);
    await tags.take({ personId: person._id, key: req.params.key, by: req.body?.by, note: req.body?.note });
    res.status(200).json({ status: "success", data: await answer(person._id) });
  })
);

async function requirePerson(id) {
  const person = mongoose.isValidObjectId(id) && (await Person.findOne({ _id: id, deletedAt: null }).select("_id").lean());
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  return person;
}
async function answer(personId) {
  const t = (await tags.tagsByPerson([personId])).get(String(personId)) || { tags: [], pastTags: [] };
  return { person: String(personId), tags: t.tags, pastTags: t.pastTags };
}

module.exports = router;
