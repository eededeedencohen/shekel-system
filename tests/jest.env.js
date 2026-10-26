/**
 * @file Pre-Jest environment shim
 *
 * Runs before Jest globals are loaded. Sets NODE_ENV=test so app.js
 * suppresses request logging (morgan only registers in non-production
 * today; tests should also be quiet).
 */

process.env.NODE_ENV = "test";
// the files bucket is a Map in the tests (services/storage/memoryStorage) - no network, no keys
process.env.STORAGE_DRIVER = "memory";
