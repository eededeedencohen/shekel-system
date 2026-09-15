/**
 * sharePreview — the per-URL Open Graph head WhatsApp reads: which section
 * a path belongs to, how the tags render, and how they land in index.html.
 */

const share = require("../../../utils/sharePreview");

const CTX = { origin: "https://shekel.example", url: "https://shekel.example/join" };

describe("previewFor", () => {
  it("maps every section to its own title", () => {
    expect(share.previewFor("/join")).toMatchObject({ key: "join", title: "הצטרפות לשק״ל" });
    expect(share.previewFor("/join/docs/abc123").key).toBe("joinDocs");
    expect(share.previewFor("/").key).toBe("home");
    expect(share.previewFor("/culture")).toMatchObject({ key: "culture", title: "תרבות לכל · שק״ל" });
    expect(share.previewFor("/courses").key).toBe("courses");
    expect(share.previewFor("/library").key).toBe("library");
    expect(share.previewFor("/pipeline", { view: "intake" }).key).toBe("intake");
    expect(share.previewFor("/pipeline").key).toBe("pipeline");
    expect(share.previewFor("/no/such/page").key).toBe("home");
    const titles = new Set(Object.values(share.STATIC).map((p) => p.title));
    expect(titles.size).toBe(Object.keys(share.STATIC).length);
  });

  it("carries the record to look up — and never a person", () => {
    expect(share.previewFor("/culture/events/6aa128921cc122dde93a3577").params).toEqual({ event: "6aa128921cc122dde93a3577" });
    expect(share.previewFor("/courses/6aa127f51cc122dde93a2239").params).toEqual({ cycle: "6aa127f51cc122dde93a2239" });
    expect(share.previewFor("/hostels/%D7%90%D7%95%D7%A4%D7%A7").params).toEqual({ hostel: "אופק" });
    expect(share.previewFor("/library", { book: "6aa13c7f76b76dbe682f5a2b" }).params).toEqual({ book: "6aa13c7f76b76dbe682f5a2b" });
    expect(share.previewFor("/library", { book: "junk" }).params).toEqual({});
    expect(share.previewFor("/students/6aa12af71cc122dde93a6434").params).toEqual({});
    expect(share.previewFor("/teachers/6aa127d91cc122dde93a1aad").params).toEqual({});
  });
});

describe("renderHead / injectPreview", () => {
  it("renders the logo as an absolute image + the url, escaped", () => {
    const head = share.renderHead({ title: 'הזוג "מהבית" <השכן>', description: "a & b" }, CTX);
    expect(head).toContain('<meta property="og:image" content="https://shekel.example/og/logo.png" />');
    expect(head).toContain('<meta property="og:url" content="https://shekel.example/join" />');
    expect(head).toContain('content="הזוג &quot;מהבית&quot; &lt;השכן&gt;"');
    expect(head).toContain('content="a &amp; b"');
    expect(head).toContain('<meta property="og:image:width" content="1200" />');
  });

  it("stamps the marker and the <title>; without a marker it goes before </head>", () => {
    const html = "<html><head><title>x</title>\n    <!--share:head--></head><body></body></html>";
    const out = share.injectPreview(html, share.previewFor("/join"), CTX);
    expect(out).toContain("<title>הצטרפות לשק״ל</title>");
    expect(out).not.toContain("<!--share:head-->");
    expect(out).toContain('og:title" content="הצטרפות לשק״ל"');
    const bare = share.injectPreview("<html><head><title>x</title></head><body></body></html>", share.previewFor("/"), CTX);
    expect(bare).toMatch(/og:title[\s\S]*<\/head>/);
  });

  it("requestUrls honours the proxy headers", () => {
    const req = { get: (h) => ({ "x-forwarded-proto": "https", "x-forwarded-host": "shekel-system.onrender.com", host: "10.0.0.1:5001" })[h.toLowerCase()], protocol: "http", originalUrl: "/culture?tab=vouchers" };
    expect(share.requestUrls(req)).toEqual({ origin: "https://shekel-system.onrender.com", url: "https://shekel-system.onrender.com/culture?tab=vouchers" });
    const bare = { get: (h) => ({ host: "localhost:5001" })[h.toLowerCase()], protocol: "http", originalUrl: "/" };
    expect(share.requestUrls(bare).origin).toBe("http://localhost:5001");
  });
});
