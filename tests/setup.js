/**
 * @file Per-file Jest setup
 *
 * Provides an in-memory MongoDB to every test file:
 *   • beforeAll  — boot a fresh MongoMemoryServer + connect mongoose
 *   • afterEach  — wipe every collection so tests cannot leak data
 *   • afterAll   — disconnect mongoose + stop the server
 *
 * This file is wired via `setupFilesAfterEach` in jest.config.js, so
 * test files do NOT need to import it.
 */

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
