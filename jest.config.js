/**
 * @file Jest configuration
 *
 * `setupFilesAfterEnv` wires tests/setup.js as a per-file setup hook so
 * every test file gets a connected in-memory MongoDB and an isolated
 * (cleared between tests) data set, with no boilerplate per file.
 */

module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/"],
  // jest.env.js runs *before* Jest globals are loaded — for env-var setup.
  setupFiles: ["<rootDir>/tests/jest.env.js"],
  // setup.js runs *after* Jest globals are loaded — uses beforeAll/afterEach.
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  // Generous timeout: the in-memory MongoDB binary spin-up on first run
  // (and on slower laptops) can take a few seconds.
  testTimeout: 30000,
};
