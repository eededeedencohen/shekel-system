/**
 * @file Share previews — the Open Graph head a link needs to look right in
 * WhatsApp (and any other chat / feed).
 * @module utils/sharePreview
 *
 * The client is a single-page app: every URL is served from one
 * index.html, and WhatsApp's crawler reads the HTML as sent, JavaScript
 * never runs. So the SERVER decides, per URL, what the preview says and
 * which picture it shows, and stamps that into the page before sending it
 * (app.js → `injectPreview`). Eden's ask (2026-09-15): "לא טקסט קבוע לכל
 * עמוד אלא דינמי" — the landing page, מכללה לכל, תרבות לכל, the library
 * each get their own title / text / image, and a link to a specific event,
 * course, hostel or book names it.
 *
 * Nothing personal ever goes into a preview: student and teacher pages
 * describe the section, never the person.
 *
 * The picture is always the logo — client/public/og/logo.png (1200×630,
 * rendered from public/logo.svg by client/scripts/brand-assets.mjs; chats
 * do not show SVG). The title and the text are what change per page.
 */

const Event = require("../models/Event");
const Cycle = require("../models/Cycle");
const Hostel = require("../models/Hostel");
const Book = require("../models/Book");
const { EVENT_CATEGORIES } = require("./domain");

const SITE = "שק״ל";
const OG_IMAGE = "logo.png"; // served from client-dist/og/
const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const TZ = "Asia/Jerusalem";

const COLLEGE_DESC = "מערכת הניהול של מכללה לכל: קורסים, מערכת שבועית, נוכחות, קליטה ושיבוץ.";

/** Static previews by section — the fallback for every URL without a record. */
const STATIC = {
  home: { title: `${SITE} · מכללה לכל`, description: "מערכת הניהול של מכללה לכל ותרבות לכל: מערכת שבועית, קליטה ושיבוץ, נוכחות, הספרייה ואירועי תרבות." },
  join: { title: "הצטרפות לשק״ל", description: "כמה שאלות קצרות ואנחנו מתחילים — מכללה לכל ותרבות לכל בירושלים. ממלאים לבד, עם ההורים או עם מתאם/ת הטיפול." },
  joinDocs: { title: "המסמכים שלי · שק״ל", description: "העלאת המסמכים לתיק הקליטה — מהטלפון, בכל זמן. רואים מה כבר התקבל ומה חסר." },
  schedule: { title: "מערכת שבועית · מכללה לכל", description: "כל המפגשים של השבוע — לפי יום, מורה, קטגוריה והוסטל." },
  gantt: { title: "ציר זמן · מכללה לכל", description: "הקורסים על פני השנה — מתי כל מחזור מתחיל ומסתיים." },
  rooms: { title: "זמינות חדרים · מכללה לכל", description: "מי בכל חדר, מתי, ואיפה יש מקום פנוי." },
  pipeline: { title: "קליטה ושיבוץ · מכללה לכל", description: "המסלול של כל מתעניין/ת — מהשיחה הראשונה ועד שיבוץ לקורס." },
  intake: { title: "קליטה (אינטייק) · שק״ל", description: "הלוח של העו״ס — ממתינים לשיחה, פגישות אינטייק, מסמכים ונקלטו." },
  matching: { title: "שולחן ההתאמות · מכללה לכל", description: "סטודנט, קורס ומורה — מי מתאים למי, לפי זמינות, גיל ורמת תפקוד." },
  hostels: { title: "הוסטלים · מכללה לכל", description: "הקורסים והסטודנטים של כל הוסטל." },
  culture: { title: "תרבות לכל · שק״ל", description: "אירועים, שוברים והסטודנטים של התוכנית — לוח שנה עברי-לועזי עם החגים." },
  courses: { title: "קורסים · מכללה לכל", description: COLLEGE_DESC },
  students: { title: "סטודנטים · מכללה לכל", description: "הסטודנטים של מכללה לכל ותרבות לכל — פרטים, תוכניות, מערכת ונוכחות." },
  teachers: { title: "מורים · מכללה לכל", description: "המורים, הקורסים שלהם וזמינות לשיבוץ." },
  library: { title: "הספרייה · שק״ל", description: "סריקה, השאלה והחזרה — עותק אחד לכל ספר, וההחזרה בלי שישי ושבת." },
  database: { title: "בסיס הנתונים · שק״ל", description: "מבט חי על האוספים והשדות של המערכת." },
  settings: { title: "הגדרות · שק״ל", description: "העדפות תצוגה אישיות." },
};

const clip = (s, n = 200) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDay = (d) => `יום ${DAY_NAMES[EN_DAYS.indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d))] || ""}`.trim();
const fmtDate = (d) => new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", timeZone: TZ }).format(d);
const fmtTime = (d) => new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(d);
const isoDay = (d) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ }).format(d);

const categoryLabel = (key) => EVENT_CATEGORIES.find((c) => c.key === key)?.label || null;

/**
 * The static preview for a URL: `{ key, title, description, params }`.
 * `params` carries the record id/name a later `enrich` may look up.
 */
function previewFor(pathname, query = {}) {
  const p = String(pathname || "/").replace(/\/+$/, "") || "/";
  const pick = (key, params = {}) => ({ key, ...STATIC[key], params });
  let m;
  if (p === "/join") return pick("join");
  if (p.startsWith("/join/docs/")) return pick("joinDocs");
  if (p === "/") return pick("home");
  if (p === "/schedule") return pick("schedule");
  if (p === "/gantt") return pick("gantt");
  if (p === "/rooms") return pick("rooms");
  if (p === "/pipeline") return pick(query.view === "intake" ? "intake" : "pipeline");
  if (p === "/matching") return pick("matching");
  if (p === "/hostels") return pick("hostels");
  if ((m = /^\/hostels\/([^/]+)$/.exec(p))) return pick("hostels", { hostel: safeDecode(m[1]) });
  if (p === "/culture") return pick("culture");
  if ((m = /^\/culture\/events\/([0-9a-f]{24})$/i.exec(p))) return pick("culture", { event: m[1] });
  if (p === "/courses") return pick("courses");
  if ((m = /^\/courses\/([0-9a-f]{24})$/i.exec(p))) return pick("courses", { cycle: m[1] });
  if (p === "/students" || p.startsWith("/students/")) return pick("students");
  if (p === "/teachers" || p.startsWith("/teachers/")) return pick("teachers");
  if (p === "/library") return pick("library", /^[0-9a-f]{24}$/i.test(String(query.book || "")) ? { book: String(query.book) } : {});
  if (p === "/database" || p.startsWith("/database/")) return pick("database");
  if (p === "/settings") return pick("settings");
  return pick("home");
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A record's own words, when the URL points at one (event, course, hostel,
 * book) — looked up in `world` (crawlers carry no header, so the real
 * world; `?world=test` works like everywhere else). Failures fall back to
 * the section's static text: a preview must never break a page.
 */
async function enrich(preview, world = "real") {
  const { params } = preview;
  try {
    if (params.event) {
      const ev = await Event.findOne({ _id: params.event, world }).lean();
      if (ev) {
        const d = new Date(ev.date);
        const when = `${fmtDay(d)}, ${fmtDate(d)} · ${fmtTime(d)}${ev.endTime ? `–${ev.endTime}` : ""}`;
        const bits = [when, categoryLabel(ev.category), ev.location].filter(Boolean);
        return { ...preview, title: `${ev.name} · תרבות לכל`, description: clip([bits.join(" · "), ev.description].filter(Boolean).join(". ")) };
      }
    }
    if (params.cycle) {
      const ci = await Cycle.findOne({ _id: params.cycle, world }).populate("subject", "name").populate("hostel", "name").lean();
      if (ci) {
        const name = ci.subject?.name || "קורס";
        const slots = (ci.schedule || []).map((s) => `יום ${DAY_NAMES[s.day] || ""} ${s.start}–${s.end}`.trim());
        const bits = [slots.join(", "), ci.hostel?.name ? `הוסטל ${ci.hostel.name}` : null].filter(Boolean);
        return { ...preview, title: `${name} · מכללה לכל`, description: clip(bits.length ? bits.join(" · ") : COLLEGE_DESC) };
      }
    }
    if (params.hostel) {
      const h = await Hostel.findOne({ name: params.hostel, world }).lean();
      if (h) return { ...preview, title: `הוסטל ${h.name} · מכללה לכל` };
    }
    if (params.book) {
      const b = await Book.findOne({ _id: params.book, world, deletedAt: null }).lean();
      if (b) return { ...preview, title: `${b.title} · הספרייה`, description: clip([b.author, b.summary].filter(Boolean).join(" — ") || STATIC.library.description) };
    }
  } catch {
    /* fall through to the static text */
  }
  return preview;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** The <meta> lines: Open Graph + the Twitter card, absolute URLs; the picture is always the logo. */
function renderHead({ title, description }, { origin, url }) {
  const img = `${origin}/og/${OG_IMAGE}`;
  return [
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE)}" />`,
    `<meta property="og:locale" content="he_IL" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(img)}" />`,
    `<meta property="og:image:secure_url" content="${esc(img)}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(title)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(img)}" />`,
  ].join("\n    ");
}

/** index.html with the preview stamped in: the <title> and the marker `<!--share:head-->`. */
function injectPreview(html, preview, ctx) {
  const head = renderHead(preview, ctx);
  let out = String(html);
  out = out.includes("<!--share:head-->") ? out.replace("<!--share:head-->", head) : out.replace(/<\/head>/i, `    ${head}\n  </head>`);
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${esc(preview.title)}</title>`);
  return out;
}

/** The public origin + full URL of a request (behind Render's proxy or bare). */
function requestUrls(req) {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "localhost").split(",")[0].trim();
  const origin = `${proto}://${host}`;
  return { origin, url: origin + req.originalUrl };
}

module.exports = { STATIC, OG_IMAGE, previewFor, enrich, renderHead, injectPreview, requestUrls, isoDay };
