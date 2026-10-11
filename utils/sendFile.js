/**
 * @file Conditional answers for stored bytes (files, thumbnails, covers)
 * @module utils/sendFile
 *
 * A file lives under a stable URL and can be REPLACED (a document uploaded
 * again, a cover changed). Caching such a URL for an hour showed the old
 * bytes beside the new thumbnail (Eden, 2026-10-11, the social-club
 * document). The rule since: every route that streams stored bytes sets an
 * ETag made of what identifies the bytes (the stored file's id + the time
 * it was uploaded) and `Cache-Control: private, no-cache` - the browser
 * keeps the bytes but asks every time, and gets a 304 while nothing
 * changed. Call it BEFORE loading the bytes: a 304 costs no read.
 *
 *   if (notModified(req, res, `${row.file.stored}-${uploadedAt}`)) return;
 */

function notModified(req, res, tag) {
  res.set("ETag", `"${String(tag).replace(/"/g, "")}"`);
  res.set("Cache-Control", "private, no-cache");
  if (req.fresh) {
    res.status(304).end();
    return true;
  }
  return false;
}

/** The tag of an intake document's file: the stored id (or the legacy disk name) + when it was uploaded. */
const docTag = (row, suffix = "") => {
  const at = row?.file?.uploadedAt ? new Date(row.file.uploadedAt).getTime() : 0;
  return `${row?.file?.stored || row?.file?.storedName || row?.key || "none"}-${at}${suffix}`;
};

module.exports = { notModified, docTag };
