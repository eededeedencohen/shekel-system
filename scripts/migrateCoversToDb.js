/**
 * @file migrateCoversToDb — book covers move from the disk into the record
 * @module scripts/migrateCoversToDb
 *
 * Until 2026-09-22 a cover was a file under UPLOAD_DIR/<world>/books/ and
 * the book kept only its name — and the deploy wiped the disk, so covers
 * vanished within days (Eden: "שהתמונות יישמרו"). Now the bytes live in
 * `cover.data` (models/Book). For every book of every world:
 *
 *   cover.storedName + the file still here   → bytes copied in, name dropped
 *   cover missing / file gone, imageUrl set  → downloaded again (booknet /
 *                                              Google Books), best effort
 *   nothing to recover                       → cover cleared
 *
 * Idempotent — a book that already carries `cover.data` is skipped:
 *
 *   cd server && node scripts/migrateCoversToDb.js              # every world
 *   cd server && node scripts/migrateCoversToDb.js --world=test
 *   cd server && node scripts/migrateCoversToDb.js --no-download # disk only
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Book = require("../models/Book");
const lookup = require("../services/bookLookupService");
const { WORLDS } = require("../utils/domain");

const worldArg = process.argv.find((a) => a.startsWith("--world="))?.slice(8);
const download = !process.argv.includes("--no-download");
if (worldArg && !WORLDS.includes(worldArg)) {
  console.error(`world לא מוכר: ${worldArg} (${WORLDS.join(" | ")})`);
  process.exit(1);
}
const uploadRoot = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

(async () => {
  const DB = process.env.DATABASE.replace("<PASSWORD>", process.env.DATABASE_PASSWORD);
  await mongoose.connect(DB);
  const filter = { ...(worldArg ? { world: worldArg } : {}), $or: [{ "cover.data": { $exists: false } }, { "cover.data": null }] };
  const books = await Book.find(filter);
  const n = { fromDisk: 0, downloaded: 0, cleared: 0, untouched: 0 };
  for (const book of books) {
    const file = book.cover?.storedName ? path.join(uploadRoot, book.world, "books", book.cover.storedName) : null;
    if (file && fs.existsSync(file)) {
      const buffer = fs.readFileSync(file);
      book.cover = { data: buffer, mime: book.cover.mime || "image/jpeg", size: buffer.length, savedAt: book.cover.savedAt || new Date() };
      await book.save();
      n.fromDisk++;
      continue;
    }
    if (download && book.imageUrl) {
      try {
        const dl = await lookup.downloadCover(book.imageUrl);
        if (dl) {
          book.cover = { data: dl.buffer, mime: dl.mime, size: dl.buffer.length, savedAt: new Date() };
          await book.save();
          n.downloaded++;
          continue;
        }
      } catch {
        /* the shop may not answer — the book stays without a cover */
      }
    }
    if (book.cover?.storedName || book.cover?.mime) {
      book.cover = undefined;
      await book.save();
      n.cleared++;
    } else n.untouched++;
  }
  const withCover = await Book.countDocuments({ ...(worldArg ? { world: worldArg } : {}), "cover.data": { $exists: true, $ne: null } });
  console.log(
    `${worldArg || "every world"}: ${books.length} books looked at — ${n.fromDisk} covers copied from the disk, ${n.downloaded} downloaded again, ` +
      `${n.cleared} stale references cleared, ${n.untouched} never had one; ${withCover} books now carry their cover`
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
