/**
 * Stage 4d of the hardening plan (2026-10-27, section 9-ד): the front
 * door - the response headers with the app's Content-Security-Policy,
 * CORS closed to the app's own origins (with credentials), and the rate
 * limits on the sign-in route, the public token pages and the upload
 * beginnings (off in the other suites: RATE_LIMIT_TEST=1 turns them on here).
 */

const request = require("supertest");
const app = require("../../../app");
const { allowedOrigins, inlineScriptHashes } = require("../../../utils/security");
const { ensureSeedAccounts } = require("../../../services/authService");

describe("the response headers", () => {
  it("carry a Content-Security-Policy made for this app and the usual helmet set", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/connect-src 'self' data: blob: https:\/\/\*\.amazonaws\.com/);
    expect(csp).toMatch(/img-src 'self' data: blob: https:\/\/\*\.amazonaws\.com/);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/worker-src 'self' blob:/);
    expect(csp).toMatch(/frame-ancestors 'self'/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("the inline theme script of index.html is admitted by its hash alone", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shekel-csp-")), "index.html");
    fs.writeFileSync(file, '<html><head><script>document.documentElement.setAttribute("data-theme", "dark");</script><script type="module" src="/x.js"></script></head></html>');
    const hashes = inlineScriptHashes(file);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/=]{44}'$/);
    expect(inlineScriptHashes(path.join(path.dirname(file), "missing.html"))).toEqual([]);
  });
});

describe("CORS", () => {
  it("answers the app's own origins with credentials and strangers with nothing", async () => {
    expect(allowedOrigins().has("https://shekel-system.onrender.com")).toBe(true);
    expect(allowedOrigins().has("http://localhost:5173")).toBe(true); // outside production
    const mine = await request(app).get("/api/health").set("Origin", "https://shekel-system.onrender.com");
    expect(mine.headers["access-control-allow-origin"]).toBe("https://shekel-system.onrender.com");
    expect(mine.headers["access-control-allow-credentials"]).toBe("true");
    const preflight = await request(app).options("/api/files/upload-url").set("Origin", "http://localhost:5173").set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,x-acting-as");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toMatch(/X-Acting-As/i);
    const stranger = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(stranger.status).toBe(200); // the API answers; the browser, without the header, will not hand the body over
    expect(stranger.headers["access-control-allow-origin"]).toBeUndefined();
    const none = await request(app).get("/api/health");
    expect(none.status).toBe(200);
  });
});

describe("the rate limits", () => {
  beforeAll(async () => {
    process.env.RATE_LIMIT_TEST = "1";
    await ensureSeedAccounts();
  });
  afterAll(() => {
    delete process.env.RATE_LIMIT_TEST;
  });

  it("twenty sign-in tries per address per quarter hour, then 429 TOO_MANY_REQUESTS with the headers that say so", async () => {
    let last;
    for (let i = 0; i < 20; i++) last = await request(app).post("/api/auth/login").send({ username: "eden", password: "wrong" });
    expect(last.body.code).not.toBe("TOO_MANY_REQUESTS"); // (the sign-in lockout answers its own code after five wrong passwords)
    expect(last.headers.ratelimit).toMatch(/remaining=0/); // draft-7: one combined RateLimit header
    const over = await request(app).post("/api/auth/login").send({ username: "eden", password: "wrong" });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("TOO_MANY_REQUESTS");
    expect(over.body.message).toMatch(/יותר מדי/);
    // the other doors are not touched by the sign-in budget
    expect((await request(app).get("/api/health")).status).toBe(200);
  });
});
