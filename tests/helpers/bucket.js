/**
 * The tests' side of a signed read: a plain content route answers 302 to
 * the memory bucket (`memory://get/<key>?name=…&inline=…&mime=…`, see
 * services/storage/memoryStorage); these read the key and the bytes back.
 */

const storage = require("../../services/storage");

/** The answer must be a redirect into the bucket → its key. */
function keyOf(res) {
  expect(res.status).toBe(302);
  expect(res.headers.location.startsWith("memory://get/")).toBe(true);
  return new URL(res.headers.location).pathname.slice(1);
}

/** The type the signed link will answer with. */
const mimeOf = (res) => new URL(res.headers.location).searchParams.get("mime");

/** The object the redirect points at. */
const bytesOf = (res) => storage.getBuffer(keyOf(res));

module.exports = { keyOf, mimeOf, bytesOf };
