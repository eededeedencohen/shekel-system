/**
 * bookLookupService — the port of booknet_book_downloader.ipynb, parsed
 * against page fixtures (no network): the search → product link, the
 * product page → title / author / summary / cover, and the source
 * fallback order with a fake fetch.
 */

const lookup = require("../../../services/bookLookupService");

const BARCODE = "36200054208";
const PRODUCT_PATH = "/מוצרים/%d7%94%d7%96%d7%95%d7%92-%d7%9e%d7%94%d7%91%d7%99%d7%aa-36200054208";

const SEARCH_HTML = `
<html><body>
  <a href="/">בית</a>
  <a href="/קטגוריות/מותחנים">מותחנים</a>
  <div class="result"><a href="${PRODUCT_PATH}"><img src="//Images/Site/Products/${BARCODE}.jpg"></a></div>
  <a href="/מוצרים/ספר-אחר-36200099999">ספר אחר</a>
</body></html>`;

const PRODUCT_HTML = `
<html><head>
  <meta content="https://www.booknet.co.il//Images/Site/Products/${BARCODE}.jpg" property="og:image" />
</head><body>
  <h1>  הזוג &quot;מהבית&quot; השכן </h1>
  <div class="pp-authors"><span>מאת:</span> <a href="/x">שרי לפניה</a></div>
  <div class="price">מחיר מכירה ₪ 49.90</div>
  <h2><span>תקציר</span></h2>
  <div class="desc"><p>אן ומרקו, זוג צעיר</p><div>עם תינוקת<br/>בת פחות משנה.</div></div>
  <h2>עוד ספרים</h2>
  <div>לא חלק מהתקציר</div>
</body></html>`;

describe("normalizeBarcode", () => {
  it("keeps digits (and a trailing X), rejects junk", () => {
    expect(lookup.normalizeBarcode(" 978-965-566-001-2 ")).toBe("9789655660012");
    expect(lookup.normalizeBarcode("36200054208")).toBe("36200054208");
    expect(lookup.normalizeBarcode("0-306-40615-x")).toBe("030640615X");
    expect(lookup.normalizeBarcode("abc")).toBeNull();
    expect(lookup.normalizeBarcode("12")).toBeNull();
    expect(lookup.normalizeBarcode("")).toBeNull();
    expect(lookup.normalizeBarcode(null)).toBeNull();
  });
});

describe("parseBooknetSearch", () => {
  it("finds the product link that carries the barcode and מוצרים (percent-encoded)", () => {
    const url = lookup.parseBooknetSearch(SEARCH_HTML, BARCODE);
    expect(url.startsWith("https://www.booknet.co.il/")).toBe(true);
    expect(decodeURIComponent(url)).toBe(`https://www.booknet.co.il${decodeURIComponent(PRODUCT_PATH)}`);
  });
  it("returns null when no result matches", () => {
    expect(lookup.parseBooknetSearch(SEARCH_HTML, "1111111111")).toBeNull();
  });
});

describe("parseBooknetProduct", () => {
  const info = lookup.parseBooknetProduct(PRODUCT_HTML, BARCODE);
  it("reads the title with entities decoded and whitespace collapsed", () => {
    expect(info.title).toBe('הזוג "מהבית" השכן');
  });
  it("reads the author out of div.pp-authors (nested tags stripped)", () => {
    expect(info.author).toBe("מאת: שרי לפניה");
  });
  it("takes the element after the תקציר heading, and only it", () => {
    expect(info.summary).toBe("אן ומרקו, זוג צעיר עם תינוקת בת פחות משנה.");
  });
  it("reads the price and fixes the doubled slash of og:image", () => {
    expect(info.price).toBe(49.9);
    expect(info.imageUrl).toBe(`https://www.booknet.co.il/Images/Site/Products/${BARCODE}.jpg`);
  });
  it("falls back to the fixed cover URL without og:image", () => {
    const i = lookup.parseBooknetProduct("<h1>x</h1>", "123456");
    expect(i.imageUrl).toBe("https://www.booknet.co.il/Images/Site/Products/123456.jpg");
    expect(i.summary).toBeNull();
  });
});

describe("lookupBook (fake network)", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const respond = (status, body, type = "text/html") => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? type : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)),
  });

  afterEach(() => lookup.setFetch(null));

  it("booknet first: search → product → cover", async () => {
    const calls = [];
    lookup.setFetch(async (url) => {
      calls.push(url);
      if (url.includes("%D7%97%D7%99%D7%A4%D7%95%D7%A9")) return respond(200, SEARCH_HTML);
      if (url.includes("/Images/")) return respond(200, PNG, "image/png");
      if (url.includes("36200054208")) return respond(200, PRODUCT_HTML);
      return respond(404, "");
    });
    const r = await lookup.lookupBook(BARCODE);
    expect(r.found).toBe(true);
    expect(r.source).toBe("booknet");
    expect(r.title).toBe('הזוג "מהבית" השכן');
    expect(r.cover.mime).toBe("image/png");
    expect(r.cover.buffer.length).toBe(PNG.length);
    expect(calls.some((u) => u.includes("googleapis"))).toBe(false);
  });

  it("falls back to Google Books when booknet has nothing", async () => {
    lookup.setFetch(async (url) => {
      if (url.includes("googleapis")) {
        return respond(200, JSON.stringify({ items: [{ volumeInfo: { title: "Dune", authors: ["Frank Herbert"], description: "Arrakis.", imageLinks: { thumbnail: "http://books.google.com/x.jpg&edge=curl" }, publishedDate: "1965-08-01", pageCount: 412, infoLink: "https://books.google.com/dune" } }] }), "application/json");
      }
      if (url.includes("booknet")) return respond(200, "<html>no results</html>");
      return respond(404, "");
    });
    const r = await lookup.lookupBook("9780441013593", { withCover: false });
    expect(r.found).toBe(true);
    expect(r.source).toBe("google");
    expect(r.author).toBe("Frank Herbert");
    expect(r.imageUrl).toBe("https://books.google.com/x.jpg");
    expect(r.year).toBe(1965);
    expect(r.pages).toBe(412);
    expect(r.cover).toBeNull();
  });

  it("reports failed:true when every source errored, found:false when they answered empty", async () => {
    lookup.setFetch(async () => {
      throw new Error("offline");
    });
    expect(await lookup.lookupBook(BARCODE)).toEqual({ found: false, failed: true });
    lookup.setFetch(async (url) => (url.includes("googleapis") ? respond(200, "{}", "application/json") : respond(200, "<html></html>")));
    expect(await lookup.lookupBook(BARCODE)).toEqual({ found: false, failed: false });
    expect(await lookup.lookupBook("nope")).toEqual({ found: false, failed: false });
  });
});
