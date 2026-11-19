/**
 * @file The app's look - what the super admin chose for everyone
 * @module services/appLookService
 *
 * Two choices, kept in one AppSetting row ("look"):
 *   intro  which opening animation plays when the app opens
 *          (client/src/components/Intro; "tour" = another one each opening,
 *          "classic" = the loading screen there always was)
 *   head   how the pages' headers are drawn (client: lib/headDesign)
 * A choice that was never made is `null`: the client then shows its own
 * default (the classic opening for everyone but the super admin, whose
 * openings go round the candidates until he chooses; the first header design).
 *
 * Everyone signed in READS it (it comes with "who am I" and with a sign-in,
 * so the opening knows what to play before anything else is asked); only the
 * super admin's own account WRITES it - also while he is viewing as someone:
 * it is his setting, not the viewed person's.
 */

const AppSetting = require("../models/AppSetting");
const AppError = require("../utils/AppError");

const KEY = "look";
const INTROS = ["tour", "classic", "assemble", "unfold", "curtain", "pulse", "snap", "colorhop"];
const HEADS = ["people", "shapes", "clean"];

const shape = (v) => ({
  intro: INTROS.includes(v?.intro) ? v.intro : null,
  head: HEADS.includes(v?.head) ? v.head : null,
});

async function get() {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  return shape(row?.value);
}

/** Change one choice or both; what is not in the patch stays. */
async function set(patch, by = "") {
  const next = {};
  // (null takes a choice back: "not chosen" again)
  if (patch && "intro" in patch) {
    if (patch.intro !== null && !INTROS.includes(patch.intro)) throw AppError.of("LOOK_INVALID", 400);
    next.intro = patch.intro;
  }
  if (patch && "head" in patch) {
    if (patch.head !== null && !HEADS.includes(patch.head)) throw AppError.of("LOOK_INVALID", 400);
    next.head = patch.head;
  }
  if (!Object.keys(next).length) throw AppError.of("LOOK_INVALID", 400);
  const now = await get();
  await AppSetting.findOneAndUpdate({ key: KEY }, { $set: { value: { ...now, ...next }, updatedBy: by } }, { upsert: true });
  return get();
}

module.exports = { get, set, INTROS, HEADS };
