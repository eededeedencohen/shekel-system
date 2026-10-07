/**
 * @file Tag routes - /api/tags: the catalog of belongings of a world
 * @module routes/tagRoutes
 */

const express = require("express");
const router = express.Router();
const catchAsync = require("../utils/catchAsync");
const tags = require("../services/tagService");
const mongoose = require("mongoose");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");

/** GET /api/tags → { groups: [{key,label}], tags: [{key,label,group,active}] } */
router.get(
  "/",
  catchAsync(async (req, res) => {
    const data = await tags.catalog(req.world);
    res.status(200).json({ status: "success", data });
  })
);

/** POST /api/tags/people/:id - { key*, by, note } → the person's tags now */
router.post(
  "/people/:id",
  catchAsync(async (req, res) => {
    const person = await requirePerson(req.params.id, req.world);
    await tags.give({ world: req.world, personId: person._id, key: req.body.key, by: req.body.by, note: req.body.note });
    res.status(200).json({ status: "success", data: await answer(req.world, person._id) });
  })
);

/** DELETE /api/tags/people/:id/:key - { by, note } → the person's tags now */
router.delete(
  "/people/:id/:key",
  catchAsync(async (req, res) => {
    const person = await requirePerson(req.params.id, req.world);
    await tags.take({ world: req.world, personId: person._id, key: req.params.key, by: req.body?.by, note: req.body?.note });
    res.status(200).json({ status: "success", data: await answer(req.world, person._id) });
  })
);

async function requirePerson(id, world) {
  const person = mongoose.isValidObjectId(id) && (await Person.findOne({ _id: id, world, deletedAt: null }).select("_id").lean());
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  return person;
}
async function answer(world, personId) {
  const t = (await tags.tagsByPerson(world, [personId])).get(String(personId)) || { tags: [], pastTags: [] };
  return { person: String(personId), tags: t.tags, pastTags: t.pastTags };
}

module.exports = router;
