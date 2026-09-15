/**
 * @file withTxn — run a unit of work inside a transaction when possible
 * @module utils/withTxn
 *
 * Atlas (a replica set — the real deployment) gets a real transaction; a
 * standalone mongod (dev fallback, the in-memory test server) runs the same
 * function plainly with `session = null`. Every caller keeps a unique index
 * as the correctness backstop, so the fallback never lies.
 */

const mongoose = require("mongoose");

async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
    } catch (e) {
      if (/Transaction numbers are only allowed|replica set|transactions are not supported/i.test(e.message || "")) {
        result = await fn(null);
      } else throw e;
    }
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { withTxn };
