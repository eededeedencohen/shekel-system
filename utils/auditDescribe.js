/**
 * @file auditDescribe - what a write was, in Hebrew
 * @module utils/auditDescribe
 *
 * The audit middleware (utils/audit) hands over a method, a path, the body
 * and the answer; this says what happened in words a person reads on the
 * activity page: a `title` ("שיבוץ לקורס", "עריכת קורס", "מחיקת אירוע"),
 * the `verb` (create / update / delete / other), the `kind` of thing it
 * touched, the `target` (its id from the path, its name from the answer)
 * and a compact `payload` of the body with every secret taken out.
 *
 * RULES names the routes one by one; whatever is not there falls back to
 * "הוספת / עריכת / מחיקת <the noun of the first path segment>".
 */

const ID_RE = /^[0-9a-f]{24}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,}$/;

/** "/cycles/65f1…/x" → "/cycles/:id/x" (ids and tokens folded). */
function normalizeRoute(path) {
  return (
    "/" +
    String(path || "")
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .map((seg) => (ID_RE.test(seg) ? ":id" : TOKEN_RE.test(seg) ? ":token" : seg))
      .join("/")
  );
}

/** The Hebrew noun of a path's first segment - the fallback's vocabulary. */
const NOUNS = {
  people: ["אדם", "person"],
  profiles: ["פרופיל", "profile"],
  subjects: ["מקצוע", "subject"],
  "subject-categories": ["קטגוריה", "category"],
  cycles: ["קורס", "course"],
  enrollments: ["שיבוץ", "enrollment"],
  lessons: ["שיעור", "lesson"],
  rooms: ["חדר", "room"],
  hostels: ["בית", "hostel"],
  "hostel-reports": ["דיווח הוסטל", "hostelReport"],
  events: ["אירוע", "event"],
  "event-registrations": ["רישום לאירוע", "registration"],
  vouchers: ["שובר", "voucher"],
  intakes: ["תיק קליטה", "intake"],
  suppliers: ["תיק ספק", "supplier"],
  activities: ["תיעוד", "activity"],
  incidents: ["אירוע חריג", "incident"],
  library: ["ספר", "book"],
  invoices: ["חשבונית", "invoice"],
  "invoice-rounds": ["סבב חשבוניות", "invoiceRound"],
  diary: ["רשומה ביומן", "diary"],
  tags: ["תגית", "tag"],
  accounts: ["משתמש", "account"],
  auth: ["החשבון שלי", "account"],
  files: ["קובץ", "file"],
};

/**
 * [method, pattern, title, kind, verb, options]
 * pattern: the normalised route; `*` stands for one free segment (a document
 * key, a template kind, a tag key…). verb defaults by method.
 * options.payload === false keeps the body out (passwords, tokens).
 */
const RULES = [
  // my account, the users page
  ["POST", "/auth/password", "שינוי הסיסמה שלי", "account", "update", { payload: false }],
  ["POST", "/accounts", "משתמש חדש", "account", "create"],
  ["PATCH", "/accounts/:id", "עריכת משתמש", "account", "update"],
  ["POST", "/accounts/:id/reset", "קישור לאיפוס סיסמה", "account", "other", { payload: false }],
  // people
  ["POST", "/people", "אדם חדש", "person", "create"],
  ["POST", "/people/intake", "מתעניין/ת חדש/ה", "person", "create"],
  ["PUT", "/people/:id", "עריכת פרטי אדם", "person", "update"],
  ["DELETE", "/people/:id", "מחיקת אדם", "person", "delete"],
  ["POST", "/people/:id/profiles", "פתיחת פרופיל", "profile", "create"],
  ["PATCH", "/people/:id/availability", "עדכון זמינות", "person", "update"],
  ["POST", "/people/:id/documents", "העלאת מסמך", "document", "create"],
  ["DELETE", "/people/:id/documents/:id", "מחיקת מסמך", "document", "delete"],
  ["POST", "/people/:id/transfer", "העברה בין תוכניות", "person", "other"],
  ["POST", "/people/:id/stage", "העברת שלב בצנרת", "person", "other"],
  ["PATCH", "/people/:id/matching", "עדכון נתוני התאמה", "person", "update"],
  // profiles
  ["PATCH", "/profiles/:id", "עריכת פרופיל", "profile", "update"],
  ["DELETE", "/profiles/:id", "סגירת פרופיל", "profile", "delete"],
  ["POST", "/profiles/:id/stage", "העברת שלב בצנרת", "profile", "other"],
  ["PATCH", "/profiles/:id/matching", "עדכון נתוני התאמה", "profile", "update"],
  ["POST", "/profiles/:id/close", "סגירת תיק", "profile", "other"],
  ["POST", "/profiles/:id/leave", "דיווח עזיבה", "profile", "other"],
  ["POST", "/profiles/:id/reopen", "פתיחת תיק מחדש", "profile", "other"],
  // files
  ["POST", "/files/:id/confirm", "העלאת קובץ", "file", "create"],
  ["DELETE", "/files/:id", "מחיקת קובץ", "file", "delete"],
  // the catalogue
  ["POST", "/subjects", "מקצוע חדש", "subject", "create"],
  ["PUT", "/subjects/:id", "עריכת מקצוע", "subject", "update"],
  ["DELETE", "/subjects/:id", "מחיקת מקצוע", "subject", "delete"],
  ["POST", "/subject-categories", "קטגוריה חדשה", "category", "create"],
  ["PUT", "/subject-categories/:id", "עריכת קטגוריה", "category", "update"],
  ["DELETE", "/subject-categories/:id", "מחיקת קטגוריה", "category", "delete"],
  ["POST", "/cycles", "קורס חדש", "course", "create"],
  ["PUT", "/cycles/:id", "עריכת קורס", "course", "update"],
  ["DELETE", "/cycles/:id", "מחיקת קורס", "course", "delete"],
  ["POST", "/enrollments", "שיבוץ לקורס", "enrollment", "create"],
  ["POST", "/enrollments/residents", "שיבוץ דיירי בית לקורס", "enrollment", "create"],
  ["PATCH", "/enrollments/:id", "עדכון שיבוץ", "enrollment", "update"],
  ["DELETE", "/enrollments/:id", "הסרת שיבוץ", "enrollment", "delete"],
  ["PUT", "/lessons/attendance", "דיווח נוכחות", "attendance", "update"],
  ["DELETE", "/lessons/:id", "מחיקת שיעור", "lesson", "delete"],
  ["POST", "/rooms", "חדר חדש", "room", "create"],
  ["PUT", "/rooms/:id", "עריכת חדר", "room", "update"],
  ["DELETE", "/rooms/:id", "מחיקת חדר", "room", "delete"],
  // the houses
  ["POST", "/hostels", "בית חדש", "hostel", "create"],
  ["PUT", "/hostels/:id", "עריכת בית", "hostel", "update"],
  ["DELETE", "/hostels/:id", "מחיקת בית", "hostel", "delete"],
  ["POST", "/hostel-reports", "פתיחת דיווח לבית", "hostelReport", "create"],
  ["DELETE", "/hostel-reports/:id", "מחיקת דיווח", "hostelReport", "delete"],
  ["POST", "/hostel-reports/:id/sent", "סימון: קישור הדיווח נשלח", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/renew", "חידוש קישור הדיווח", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/reopen", "פתיחת הדיווח מחדש", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/note", "הערה על הדיווח", "hostelReport", "update"],
  ["POST", "/hostel-reports/:id/approve", "אישור כל המפגשים בדיווח", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/sessions/:id/approve", "אישור מפגש בדיווח", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/sessions/:id/state", "עדכון מצב מפגש בדיווח", "hostelReport", "update"],
  ["POST", "/hostel-reports/:id/sessions/:id/marks", "סימון נוכחות במפגש", "hostelReport", "update"],
  ["POST", "/hostel-reports/:id/sessions/:id/fill", "מילוי מפגש בדיווח", "hostelReport", "update"],
  ["DELETE", "/hostel-reports/:id/sessions/:id/approval", "ביטול אישור מפגש", "hostelReport", "other"],
  ["DELETE", "/hostel-reports/:id/sessions/:id/staff", "ביטול סימון הרכזת במפגש", "hostelReport", "other"],
  ["DELETE", "/hostel-reports/:id/sessions/:id", "איפוס מפגש בדיווח", "hostelReport", "delete"],
  ["POST", "/hostel-reports/:id/extras/:id/resolve", "טיפול במשתתף/ת שלא ברשימה", "hostelReport", "other"],
  ["POST", "/hostel-reports/:id/left/:id/resolve", "טיפול בדיווח עזיבה מהבית", "hostelReport", "other"],
  // תרבות לכל
  ["POST", "/events", "אירוע חדש", "event", "create"],
  ["PUT", "/events/:id", "עריכת אירוע", "event", "update"],
  ["DELETE", "/events/:id", "מחיקת אירוע", "event", "delete"],
  ["POST", "/events/:id/publish", "פרסום אירוע", "event", "other"],
  ["POST", "/events/:id/cancel", "ביטול אירוע", "event", "other"],
  ["POST", "/events/:id/done", "סימון: האירוע התקיים", "event", "other"],
  ["POST", "/event-registrations", "רישום לאירוע", "registration", "create"],
  ["POST", "/event-registrations/:id/cancel", "ביטול רישום לאירוע", "registration", "delete"],
  ["PATCH", "/event-registrations/:id/attendance", "דיווח הגעה לאירוע", "registration", "update"],
  ["POST", "/vouchers", "שובר חדש", "voucher", "create"],
  ["PUT", "/vouchers/:id", "עריכת שובר", "voucher", "update"],
  ["DELETE", "/vouchers/:id", "מחיקת שובר", "voucher", "delete"],
  ["PATCH", "/vouchers/:id/image", "תמונה לשובר", "voucher", "update"],
  ["POST", "/vouchers/:id/grant", "חלוקת שובר", "voucher", "other"],
  ["POST", "/vouchers/:id/redeem", "מימוש שובר", "voucher", "other"],
  ["POST", "/vouchers/:id/revoke", "ביטול חלוקת שובר", "voucher", "other"],
  // קליטה
  ["POST", "/intakes/open", "פתיחת תיק קליטה", "intake", "create"],
  ["POST", "/intakes/schedule", "קביעת אינטייק", "intake", "other"],
  ["POST", "/intakes/screening", "שיחה ראשונית", "intake", "other"],
  ["PATCH", "/intakes/:id", "עריכת תיק קליטה", "intake", "update"],
  ["POST", "/intakes/:id/schedule", "קביעת אינטייק מחדש", "intake", "other"],
  ["POST", "/intakes/:id/done", "סיום אינטייק", "intake", "other"],
  ["POST", "/intakes/:id/documents", "העלאת מסמך לתיק", "document", "create"],
  ["PATCH", "/intakes/:id/documents/*", "עדכון מסמך בתיק", "document", "update"],
  ["POST", "/intakes/:id/waiver", "חתימת ויתור סודיות", "intake", "other"],
  ["PATCH", "/intakes/:id/shkedia", "קליטה בשקדיה", "intake", "other"],
  ["PATCH", "/intakes/:id/coordinator", "שיוך רכזת מטפלת", "intake", "update"],
  ["PATCH", "/intakes/:id/screening", "עדכון השיחה הראשונית", "intake", "update"],
  ["PATCH", "/intakes/:id/committee", "תאריך ועדת שיקום", "intake", "update"],
  ["POST", "/intakes/:id/links", "קישור זמני להעלאת מסמכים", "intake", "other"],
  // ספקים
  ["POST", "/suppliers", "פתיחת תיק ספק", "supplier", "create"],
  ["PATCH", "/suppliers/:id", "עריכת תיק ספק", "supplier", "update"],
  ["DELETE", "/suppliers/:id", "מחיקת תיק ספק", "supplier", "delete"],
  ["POST", "/suppliers/:id/link", "חידוש הקישור לספק", "supplier", "other"],
  ["POST", "/suppliers/:id/review", "בדיקת תיק ספק", "supplier", "other"],
  ["POST", "/suppliers/:id/seen", "סימון: תיק הספק נצפה", "supplier", "other"],
  ["POST", "/suppliers/:id/email", "שלב המייל של תיק ספק", "supplier", "other"],
  ["POST", "/suppliers/:id/admin", "פעולת ניהול על תיק ספק", "supplier", "other"],
  // the record
  ["POST", "/activities", "תיעוד חדש ברשומה", "activity", "create"],
  ["PATCH", "/activities/:id", "עריכת תיעוד", "activity", "update"],
  ["DELETE", "/activities/:id", "מחיקת תיעוד", "activity", "delete"],
  ["PUT", "/activities/templates/*", "עריכת תבנית תיעוד", "activity", "update"],
  ["DELETE", "/activities/templates/*", "איפוס תבנית תיעוד", "activity", "other"],
  ["POST", "/incidents", "דיווח אירוע חריג", "incident", "create"],
  ["PATCH", "/incidents/:id", "עריכת אירוע חריג", "incident", "update"],
  // הספרייה
  ["POST", "/library/books", "ספר חדש", "book", "create"],
  ["PATCH", "/library/books/:id", "עריכת ספר", "book", "update"],
  ["DELETE", "/library/books/:id", "מחיקת ספר", "book", "delete"],
  ["POST", "/library/books/:id/lend", "השאלת ספר", "loan", "other"],
  ["POST", "/library/loans/:id/extend", "הארכת השאלה", "loan", "other"],
  ["POST", "/library/loans/:id/return", "החזרת ספר", "loan", "other"],
  // חשבוניות
  ["POST", "/invoices", "חשבונית חדשה", "invoice", "create"],
  ["PATCH", "/invoices/:id", "עריכת חשבונית", "invoice", "update"],
  ["DELETE", "/invoices/:id", "מחיקת חשבונית", "invoice", "delete"],
  ["POST", "/invoice-rounds", "פתיחת סבב חשבוניות", "invoiceRound", "create"],
  ["DELETE", "/invoice-rounds/:id", "מחיקת סבב חשבוניות", "invoiceRound", "delete"],
  ["POST", "/invoice-rounds/:id/mail", "כתובת המייל של הסבב", "invoiceRound", "update"],
  ["POST", "/invoice-rounds/:id/note", "הערה על הסבב", "invoiceRound", "update"],
  ["POST", "/invoice-rounds/:id/requests/:id/sent", "סימון: הקישור נשלח למורה", "invoiceRound", "other"],
  ["POST", "/invoice-rounds/:id/requests/:id/renew", "חידוש הקישור למורה", "invoiceRound", "other"],
  ["POST", "/invoice-rounds/:id/requests/:id/reopen", "פתיחת בקשת חשבונית מחדש", "invoiceRound", "other"],
  ["POST", "/invoice-rounds/:id/admin", "פעולת ניהול על הסבב", "invoiceRound", "other"],
  // יומן, תגיות
  ["POST", "/diary", "רשומה חדשה ביומן", "diary", "create"],
  ["PATCH", "/diary/:id", "עריכת רשומה ביומן", "diary", "update"],
  ["DELETE", "/diary/:id", "מחיקת רשומה מהיומן", "diary", "delete"],
  ["POST", "/tags/people/:id", "הוספת תגית לאדם", "tag", "create"],
  ["DELETE", "/tags/people/:id/*", "הסרת תגית מאדם", "tag", "delete"],
];

const toRegex = (pattern) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$");
const COMPILED = RULES.map(([method, pattern, title, kind, verb, options]) => ({ method, re: toRegex(pattern), title, kind, verb, options: options || {} }));

const VERB_BY_METHOD = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
const PREFIX_BY_VERB = { create: "הוספת", update: "עריכת", delete: "מחיקת", other: "פעולה על" };

/** The rule a method + normalised route fall under, or the generic one. */
function ruleFor(method, route) {
  const hit = COMPILED.find((r) => r.method === method && r.re.test(route));
  if (hit) return { title: hit.title, kind: hit.kind, verb: hit.verb || VERB_BY_METHOD[method] || "other", options: hit.options };
  const first = route.split("/")[1] || "";
  const noun = NOUNS[first];
  const verb = VERB_BY_METHOD[method] || "other";
  return { title: noun ? `${PREFIX_BY_VERB[verb]} ${noun[0]}` : `${method} ${route}`, kind: noun ? noun[1] : "", verb, options: {} };
}

/* ───────── the payload: the body, compact and without secrets ───────── */

const SECRET_KEY = /pass|token|secret|hash|signature|dataurl|base64|cookie|authorization/i;
const MAX_STRING = 160;
const MAX_KEYS = 24;
const MAX_ARRAY = 6;
const MAX_JSON = 2000;

function compact(value, depth) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^data:/i.test(value)) return "[תמונה]";
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length} פריטים]`;
    const head = value.slice(0, MAX_ARRAY).map((v) => compact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `… ועוד ${value.length - MAX_ARRAY}`] : head;
  }
  if (typeof value === "object") {
    if (depth >= 2) return "{…}";
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      if (++n > MAX_KEYS) {
        out["…"] = `ועוד ${Object.keys(value).length - MAX_KEYS} שדות`;
        break;
      }
      out[k] = compact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** The request body as the audit keeps it: small, two levels deep, no secrets; null when there is nothing to say. */
function sanitizePayload(body) {
  if (!body || typeof body !== "object") return null;
  let out = compact(body, 0);
  if (out && typeof out === "object" && !Array.isArray(out) && Object.keys(out).length === 0) return null;
  try {
    const text = JSON.stringify(out);
    if (text.length > MAX_JSON) out = { "…": "הגוף גדול מדי לתיעוד", fields: Object.keys(body).filter((k) => !SECRET_KEY.test(k)).slice(0, MAX_KEYS) };
  } catch {
    return null;
  }
  return out;
}

/* ───────── the target: its id from the path, its name from the answer ───────── */

const LABEL_KEYS = ["name", "title", "label", "fullName", "number", "barcode"];

function labelOfObject(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return "";
  for (const k of LABEL_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && k === "number") return `#${v}`;
  }
  if (typeof o.firstName === "string" || typeof o.lastName === "string") {
    const full = `${o.firstName || ""} ${o.lastName || ""}`.trim();
    if (full) return full;
  }
  if (o.subject && typeof o.subject === "object" && typeof o.subject.name === "string") return o.subject.name;
  if (o.person && typeof o.person === "object") return labelOfObject(o.person);
  return "";
}

/** The name the answer carries for what was written - the thing itself, or the first named thing inside `data`. */
function labelOfAnswer(answer) {
  const data = answer && typeof answer === "object" ? answer.data : null;
  if (!data || typeof data !== "object") return "";
  const own = labelOfObject(data);
  if (own) return own;
  for (const v of Object.values(data)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const l = labelOfObject(v);
      if (l) return l;
    }
  }
  return "";
}

function idOfAnswer(answer) {
  const data = answer && typeof answer === "object" ? answer.data : null;
  if (!data || typeof data !== "object") return null;
  if (data._id) return String(data._id);
  for (const v of Object.values(data)) {
    if (v && typeof v === "object" && !Array.isArray(v) && v._id) return String(v._id);
  }
  return null;
}

/**
 * { title, verb, kind, target: { id, label }, payload } for one write.
 * `path` is the request path under /api; `answer` the JSON the API sent.
 */
function describe({ method, path, body, answer }) {
  const route = normalizeRoute(path);
  const rule = ruleFor(method, route);
  const idInPath = String(path || "")
    .split("/")
    .find((seg) => ID_RE.test(seg));
  const target = { id: idInPath || idOfAnswer(answer), label: labelOfAnswer(answer).slice(0, 120) };
  const payload = rule.options.payload === false ? null : sanitizePayload(body);
  return { route, title: rule.title, verb: rule.verb, kind: rule.kind, target, payload };
}

module.exports = { describe, normalizeRoute, ruleFor, sanitizePayload, labelOfAnswer, RULES, NOUNS };
