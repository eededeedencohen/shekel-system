/**
 * @file The storage driver in use: S3 for the app, memory for the tests
 * @module services/storage
 *
 * STORAGE_DRIVER=memory|s3 decides; unset, the tests (NODE_ENV=test) get
 * memory and everything else S3. One contract (see s3Storage):
 * presignPut, presignGet, head, remove, removeMany, clearPending,
 * putBuffer, getBuffer.
 */

const driver = process.env.STORAGE_DRIVER || (process.env.NODE_ENV === "test" ? "memory" : "s3");
module.exports = driver === "memory" ? require("./memoryStorage") : require("./s3Storage");
