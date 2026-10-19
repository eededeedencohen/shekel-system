/**
 * @file diaryController - a staff member's own diary (שמרית, 2026-10-14):
 * notes on days and tasks that are done or not. Every row belongs to the
 * ACTING account - viewing as someone reads and writes their diary, so a
 * borrowed lens is that person here too.
 * @module controllers/diaryController
 */

const DiaryEntry = require("../models/DiaryEntry");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { DIARY_KINDS } = require("../utils/domain");

const ownerOf = (req) => String(req.actor?._id || req.actor?.username || "");
const by = (req) => req.actor?.name || req.account?.name || "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max) => (v == null ? undefined : String(v).trim().slice(0, max));

function pick(body = {}, { creating = false } = {}) {
  const out = {};
  if ("date" in body || creating) {
    if (!DATE_RE.test(String(body.date || ""))) throw AppError.of("DIARY_INVALID", 400);
    out.date = body.date;
  }
  if ("title" in body || creating) {
    const title = clean(body.title, 160);
    if (!title) throw AppError.of("DIARY_INVALID", 400);
    out.title = title;
  }
  if ("body" in body) out.body = clean(body.body, 4000) || "";
  if ("kind" in body) out.kind = DIARY_KINDS.includes(body.kind) ? body.kind : "note";
  if ("done" in body) {
    out.done = !!body.done;
    out.doneAt = body.done ? new Date() : null;
  }
  if ("about" in body) {
    const a = body.about || {};
    out.about = { person: a.person || null, hostel: a.hostel || null };
  }
  return out;
}

exports.list = catchAsync(async (req, res) => {
  const filter = { world: req.world, owner: ownerOf(req) };
  if (req.query.from) filter.date = { ...(filter.date || {}), $gte: String(req.query.from) };
  if (req.query.to) filter.date = { ...(filter.date || {}), $lte: String(req.query.to) };
  const entries = await DiaryEntry.find(filter).sort({ date: 1, createdAt: 1 });
  res.status(200).json({ status: "success", results: entries.length, data: { entries } });
});

exports.create = catchAsync(async (req, res) => {
  const entry = await DiaryEntry.create({ ...pick(req.body, { creating: true }), world: req.world, owner: ownerOf(req), createdBy: by(req) });
  res.status(201).json({ status: "success", data: { entry } });
});

async function load(req) {
  const entry = await DiaryEntry.findOne({ _id: req.params.id, world: req.world, owner: ownerOf(req) });
  if (!entry) throw AppError.of("NOT_FOUND", 404, "רשומה ביומן");
  return entry;
}

exports.update = catchAsync(async (req, res) => {
  const entry = await load(req);
  Object.assign(entry, pick(req.body));
  await entry.save();
  res.status(200).json({ status: "success", data: { entry } });
});

exports.remove = catchAsync(async (req, res) => {
  const entry = await load(req);
  await DiaryEntry.deleteOne({ _id: entry._id });
  res.status(204).json({ status: "success", data: null });
});
