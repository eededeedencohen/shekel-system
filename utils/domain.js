/**
 * @file Shared domain constants
 * @module utils/domain
 *
 * Single source of truth for cross-cutting enums. English keys are what is
 * stored in the DB and travels over the wire; Hebrew labels are shipped
 * alongside so clients render labels without their own mapping tables.
 */

/**
 * Attendance statuses (exactly three — anything else is inferred, not stored):
 *  - Present          = נכח    — attended the lesson.
 *  - AnnouncedAbsence = לא נכח — announced in advance they would not attend.
 *  - Missing          = נעדר   — did not show and whereabouts unknown (concerning).
 * A past date with no record simply means "not reported" and is never stored.
 */
const ATTENDANCE_STATUSES = ["Present", "AnnouncedAbsence", "Missing"];

const ATTENDANCE_LABELS = {
  Present: "נכח",
  AnnouncedAbsence: "לא נכח",
  Missing: "נעדר",
};

/**
 * The מכללה לכל pipeline — Eden's spec (2026-09-17), which replaced the
 * eight keys of the 2026-09-09 diagram with five stops and one side door:
 *
 *   landing page / "+ מתעניין חדש" ──► Interested   tag "מתעניין במכללה לכל"
 *   נועה/חגי move it BY HAND       ──► Matching     waiting for a cycle
 *   a seat is RESERVED (cycle only, ──► Intake       "קליטה אצל העובדת סוציאלית":
 *     no start date)                                  automatic — enrollmentService
 *       ייטב: שיחה ראשונית → בהמתנה לאינטייק → בוצע אינטייק,
 *       + אישור שקדייה + the four documents — all on the `intakes` record
 *   the file is complete           ──► AwaitingPlacement  automatic — intakeService:
 *                                                  the baton is back with the managers,
 *                                                  a seat is held, the start date is missing
 *   נועה/חגי enter the start date  ──► Placed       automatic — enrollmentService
 *   a student who lost a course    ──► NeedsReplacement (shown inside "בחיפוש שיבוץ")
 *
 * תרבות לכל runs the short form: Interested → Intake (ייטב) → Placed.
 *
 * `owner` says whose board a stage belongs to: "college" = the מכללה לכל
 * managers, "social" = the social worker's, "all" = both. The social stage
 * is locked for managers; only the automatic moves above and the intake
 * service touch it. `stageHistory` records everything.
 */
const PIPELINE_STAGES = [
  { key: "Interested", label: "מתעניין", short: "מתעניין", owner: "all" },
  { key: "Matching", label: "בחיפוש שיבוץ", short: "בחיפוש שיבוץ", owner: "college" },
  { key: "Intake", label: "קליטה אצל העובדת סוציאלית", short: "אצל העו\"ס", owner: "social" },
  { key: "AwaitingPlacement", label: "ממתין לשיבוץ סופי לקורס", short: "לשיבוץ סופי", owner: "college" },
  { key: "NeedsReplacement", label: "דרוש שיבוץ מחדש", short: "שיבוץ מחדש", owner: "college" },
  { key: "Placed", label: "משובץ", short: "משובץ", owner: "all" },
];

const PIPELINE_STAGE_KEYS = PIPELINE_STAGES.map((s) => s.key);
/**
 * Retired keys of the 2026-09-09 diagram → what they mean today. Stored
 * data was rewritten by scripts/migratePipelineStages.js; the map stays so
 * old exports / notes can still be read.
 */
const LEGACY_STAGE_MAP = { ReservedSeat: "Intake", AwaitingDocuments: "Intake" };
/** The social worker's turf — college managers may not move this. */
const INTAKE_STAGES = ["Intake"];
/** Stages a person is in BEFORE the intake begins. */
const PRE_INTAKE_STAGES = ["Interested", "Matching"];

/* ───────────────────────── קליטה (אינטייק) ───────────────────────── */

/**
 * The intake file (Eden, 2026-09-17): exactly FOUR documents — the tag on
 * the student reads "X מתוך 4 מסמכים התקבלו" / "כל המסמכים התקבלו" — plus
 * "אישור שקדייה", an approval the office receives (`approval: true`: its
 * own tag, never counted among the four, not on the landing page; marking
 * it received REQUIRES a "valid until" date — Eden: "חובה לשייך תאריך").
 * The landing page and the personal link show every `upload:true`
 * document, together with the staff's comment on it. The file is complete
 * when the intake was held, the approval is in (and not expired) and all
 * four documents are in.
 */
const INTAKE_DOCUMENTS = [
  { key: "psychiatric", label: "דוח פסיכיאטרי", hint: "עדכני", upload: true },
  { key: "psychosocial", label: "דוח פסיכוסוציאלי", upload: true },
  { key: "socialClub", label: "אישור מועדון חברתי", upload: true },
  { key: "waiver", label: "אישור ויתור סודיות", hint: "נחתם בפגישת האינטייק או מועלה חתום", upload: true },
  { key: "shkedia", label: "אישור שקדייה", approval: true, upload: false },
];
const INTAKE_DOCUMENT_KEYS = INTAKE_DOCUMENTS.map((d) => d.key);
/** The four documents behind the "מסמכים" tag. */
const INTAKE_REQUIRED_DOCUMENTS = INTAKE_DOCUMENTS.filter((d) => !d.optional && !d.approval);
/** The approvals (today: אישור שקדייה) — each has its own tag. */
const INTAKE_APPROVALS = INTAKE_DOCUMENTS.filter((d) => d.approval);

/** A document's state. uploaded/received/waived all satisfy the checklist. */
const DOCUMENT_STATUSES = ["missing", "uploaded", "received", "waived", "rejected"];
const DOCUMENT_STATUS_LABELS = {
  missing: "חסר",
  uploaded: "הועלה",
  received: "התקבל",
  waived: "לא נדרש",
  rejected: "נדחה",
};
const DOCUMENT_OK_STATUSES = ["uploaded", "received", "waived"];

/**
 * The intake record's own state (denormalized by intakeService):
 *   new        — no call yet
 *   scheduled  — the meeting is set ("בהמתנה לאינטייק")
 *   documents  — the meeting was held; the approval and/or documents are missing
 *   complete   — held + approval + all four documents
 */
const INTAKE_STATUSES = ["new", "scheduled", "documents", "complete"];
const INTAKE_STATUS_LABELS = {
  new: "טרם בוצעה שיחה ראשונית",
  scheduled: "בהמתנה לאינטייק",
  documents: "בוצע אינטייק · משלימים תיק",
  complete: "הקליטה הושלמה",
};
/**
 * The "סטטוס עובדת סוציאלית" tag on a student (Eden's three values) —
 * derived from the record: no meeting / meeting set / meeting held.
 */
const INTAKE_SW_STATUSES = ["new", "scheduled", "done"];
const INTAKE_SW_STATUS_LABELS = {
  new: "טרם בוצעה שיחה ראשונית",
  scheduled: "בהמתנה לאינטייק",
  done: "בוצע אינטייק",
};

/** Who filled the landing page. */
const INTAKE_FILLED_BY = [
  { key: "self", label: "אני (הסטודנט/ית)" },
  { key: "family", label: "בן/בת משפחה" },
  { key: "coordinator", label: "מתאם/ת טיפול או מסגרת" },
  { key: "staff", label: "צוות שק\"ל" },
];
const INTAKE_FILLED_BY_KEYS = INTAKE_FILLED_BY.map((f) => f.key);
const INTAKE_SOURCES = ["landing", "staff"];
const INTAKE_LOG_ACTIONS = [
  "submitted", "scheduled", "rescheduled", "done", "completed",
  "docUploaded", "docReceived", "docWaived", "docRejected", "docReset", "docNote", "note",
];
/** Preferred time of day (landing page, מכללה לכל). */
const DAY_PARTS = [
  { key: "morning", label: "בוקר" },
  { key: "afternoon", label: "צהריים" },
  { key: "evening", label: "ערב" },
];

/**
 * Matching-profile scales (spec: "שולחן ההתאמות").
 * Functioning level is a simple three-step scale chosen by Eden;
 * group preference: "Private" is a HARD filter (groups never offered),
 * age/functioning mismatches are soft warnings.
 */
const FUNCTIONING_LEVELS = ["High", "Medium", "Low"];
const FUNCTIONING_LABELS = {
  High: "רמת תפקוד גבוהה",
  Medium: "רמת תפקוד בינונית",
  Low: "רמת תפקוד נמוכה",
};
const GROUP_PREFERENCES = ["Group", "Private", "Flexible"];

/**
 * Known hostel names. Used to validate imports only — CourseInstance.hostel
 * stays a plain String so adding a hostel never requires a migration.
 */
const HOSTELS = [
  "ליבא",
  "אופק",
  "השיירות",
  "בית גלעדי",
  "מצפה רעות",
  "בית רעות",
  "עתיד",
  "בית אחווה",
  "שושן",
];

/**
 * Data worlds (demo isolation). `world` is a REQUIRED field on every
 * collection, injected by server middleware from the X-Dataset header —
 * never taken from a request body. "real" is the default.
 */
const WORLDS = ["real", "pokemon", "test"];
const WORLD_LABELS = { real: "אמיתי", pokemon: "פוקימון", test: "טסט" };

/**
 * Profile kinds — the user types of the identity+profiles split. A person
 * holds any number of profiles ({person,kind} unique); adding a kind here +
 * a discriminator file under models/profiles/ is ALL a new user type needs.
 */
const PROFILE_KINDS = [
  { key: "StudentCollege", label: "סטודנט/ית מכללה לכל" },
  { key: "StudentCulture", label: "סטודנט/ית תרבות לכל" },
  { key: "Teacher", label: "מורה" },
  { key: "ManagerCollege", label: "מנהל/ת מכללה לכל" },
  { key: "ManagerCulture", label: "צוות תרבות לכל" },
  { key: "ManagerHostel", label: "מנהל/ת הוסטל" },
  { key: "SocialWorker", label: "עובד/ת סוציאלי/ת" },
  { key: "Admin", label: "מנהל/ת מערכת" },
];
const PROFILE_KIND_KEYS = PROFILE_KINDS.map((k) => k.key);
/** The kinds that make a person a "student" (enrollable, has a pipeline). */
const STUDENT_KINDS = ["StudentCollege", "StudentCulture"];

/**
 * The PROGRAMS a student can belong to — exactly the student kinds, with
 * the department name people use. A person may hold both (rare) and may
 * transfer between them; every step is logged on the profile (see
 * PROFILE_EVENTS + services/programService).
 */
const PROGRAMS = [
  { key: "StudentCollege", label: "מכללה לכל", short: "מכללה" },
  { key: "StudentCulture", label: "תרבות לכל", short: "תרבות" },
];
const PROGRAM_LABELS = Object.fromEntries(PROGRAMS.map((p) => [p.key, p.label]));

/**
 * Profile lifecycle events — the append-only `log` on every profile.
 * transferredOut/transferredIn always come in pairs (one per side) and
 * carry `otherKind` so each side of the move is readable on its own.
 */
const PROFILE_EVENTS = [
  { key: "opened", label: "נפתח" },
  { key: "closed", label: "נסגר" },
  { key: "reopened", label: "נפתח מחדש" },
  { key: "transferredOut", label: "עבר לתוכנית אחרת" },
  { key: "transferredIn", label: "הגיע מתוכנית אחרת" },
];
const PROFILE_EVENT_KEYS = PROFILE_EVENTS.map((e) => e.key);

/* ───────────────────────── תרבות לכל ───────────────────────── */

/**
 * Culture-event categories (English keys in the DB) — the vocabulary of the
 * real "יציאות בקהילה" senzey data, at the grain Eden asked for (2026-09-07:
 * "אני ממש רוצה להבדיל בין סטנדאפ למופע של זמר והצגה"): every kind of
 * performance is its own category, restaurants are not bowling, a museum
 * is not a hike. `group` only organises the pick-list (optgroups) and the
 * legend; `hint` is the pick-list's parenthesis. The pre-split keys
 * (`show`, `outing`, `trip`…) stay valid so stored events never break —
 * `show` is now the catch-all "מופע אחר" (scripts/retagEventCategories.js
 * re-files what a name makes obvious).
 */
const EVENT_CATEGORY_GROUPS = [
  { key: "shows", label: "מופעים" },
  { key: "culture", label: "תרבות ואמנות" },
  { key: "outings", label: "יציאות ובילוי" },
  { key: "community", label: "קהילה ופעילות" },
];
const EVENT_CATEGORIES = [
  { key: "theatre", label: "הצגה", group: "shows" },
  { key: "musical", label: "מחזמר", group: "shows" },
  { key: "concert", label: "הופעה", hint: "זמר/ת, להקה, קונצרט", group: "shows" },
  { key: "standup", label: "סטנדאפ", group: "shows" },
  { key: "dance", label: "מופע מחול", group: "shows" },
  { key: "show", label: "מופע אחר", hint: "קרקס, קסמים, מופע ילדים", group: "shows" },
  { key: "movie", label: "סרט", group: "culture" },
  { key: "museum", label: "מוזיאון / תערוכה", group: "culture" },
  { key: "lecture", label: "הרצאה", group: "culture" },
  { key: "restaurant", label: "מסעדה / בית קפה", group: "outings" },
  { key: "outing", label: "בילוי", hint: "באולינג, קריוקי, חדר בריחה", group: "outings" },
  { key: "trip", label: "טיול / סיור", group: "outings" },
  { key: "festival", label: "פסטיבל / אירוע עירוני", group: "outings" },
  { key: "sportEvent", label: "משחק ספורט", hint: "צפייה ביציע", group: "outings" },
  { key: "community", label: "מפגש חברתי", hint: "בוקר נשים, ערב הורים, ערב על האש", group: "community" },
  { key: "party", label: "מסיבה / חגיגת חג", group: "community" },
  { key: "workshop", label: "סדנה", group: "community" },
  { key: "sport", label: "פעילות ספורט", hint: "אימון, משחק משותף", group: "community" },
  { key: "volunteering", label: "התנדבות", group: "community" },
  { key: "other", label: "אחר" },
];
const EVENT_CATEGORY_KEYS = EVENT_CATEGORIES.map((c) => c.key);

/**
 * Event lifecycle. Only a PUBLISHED event accepts registrations; `done` is
 * set by staff after the date (attendance is reported on the registrations).
 */
const EVENT_STATUSES = ["draft", "published", "cancelled", "done"];
const EVENT_STATUS_LABELS = {
  draft: "טיוטה",
  published: "פורסם",
  cancelled: "בוטל",
  done: "התקיים",
};

/** Who an event is open to (settings.gender in the ERD: כולם/גברים/נשים). */
const EVENT_GENDER_SCOPES = ["all", "men", "women"];
const EVENT_GENDER_LABELS = { all: "כולם", men: "גברים", women: "נשים" };

/**
 * Event-registration states — ONE record per (event, student):
 *  registered = holds a seat
 *  waitlisted = in the queue (waitlist.position), promoted on a cancellation
 *  cancelled  = gave up the seat / removed (history says who and why)
 */
const REGISTRATION_STATUSES = ["registered", "waitlisted", "cancelled"];
const REGISTRATION_STATUS_LABELS = {
  registered: "רשום/ה",
  waitlisted: "ברשימת המתנה",
  cancelled: "בוטל",
};
/** Every step recorded in registration.history (the ERD's היסטוריית הרשמות). */
const REGISTRATION_ACTIONS = [
  { key: "registered", label: "נרשם/ה" },
  { key: "waitlisted", label: "נכנס/ה לרשימת המתנה" },
  { key: "promoted", label: "קודם/ה מרשימת ההמתנה" },
  { key: "cancelled", label: "ביטל/ה" },
  { key: "attended", label: "דווח: נכח/ה" },
  { key: "absent", label: "דווח: לא הגיע/ה" },
];
const REGISTRATION_ACTION_KEYS = REGISTRATION_ACTIONS.map((a) => a.key);

/** Cycle (course-run) lifecycle. Planned = demand-driven, never joinable. */
const CYCLE_STATUSES = ["Planned", "Active", "Completed", "Cancelled"];
const CYCLE_STATUS_LABELS = {
  Planned: "מתוכנן",
  Active: "פעיל",
  Completed: "הסתיים",
  Cancelled: "בוטל",
};

/**
 * Enrollment states — the ONE definition of occupancy:
 *  reserved  = seat held by Noa during intake (counts against capacity)
 *  active    = enrolled and attending
 *  completed = finished the cycle (graduated — distinct from dropping out)
 *  left      = left before the cycle ended
 */
const ENROLLMENT_STATUSES = ["reserved", "active", "completed", "left"];
const ENROLLMENT_STATUS_LABELS = {
  reserved: "מקום שמור",
  active: "משובץ",
  completed: "סיים",
  left: "עזב",
};
/** Statuses that occupy a seat. */
const OCCUPYING_STATUSES = ["reserved", "active"];

/**
 * Subject taxonomy categories — English keys in the DB, Hebrew labels here.
 * Mapped from the legacy Hebrew BaseCourse.category values at migration.
 */
const SUBJECT_CATEGORIES = [
  { key: "music", label: "מוזיקה" },
  { key: "art", label: "אומנות" },
  { key: "movement", label: "תנועה ומחול" },
  { key: "crafts", label: "מלאכה" },
  { key: "cooking", label: "בישול" },
  { key: "media", label: "מדיה ועיצוב" },
  { key: "enrichment", label: "לימודים והעשרה" },
  { key: "lifeSkills", label: "כישורי חיים" },
  { key: "animals", label: "בעלי חיים" },
  { key: "events", label: "אירועים" },
  { key: "pokemon", label: "סוג פוקימון" },
  { key: "other", label: "אחר" },
];
const SUBJECT_CATEGORY_KEYS = SUBJECT_CATEGORIES.map((c) => c.key);

/**
 * הספרייה — books lent to students. ONE copy per book (Eden, 2026-09-09),
 * so a book is either on the shelf or with exactly one student. Return
 * dates skip Friday and Shabbat (the calendar the staff pick from greys
 * them out; the server refuses them too).
 */
const LIBRARY = {
  /** Default loan length the date picker proposes. */
  defaultLoanDays: 14,
  /** The farthest return date a loan (or an extension) may set. */
  maxLoanDays: 120,
  /** Weekdays (0 = Sunday) a return date may NOT fall on. */
  closedDays: [5, 6],
};
/** Where a book's details came from. */
const BOOK_SOURCES = ["booknet", "google", "manual"];
const BOOK_SOURCE_LABELS = { booknet: "צומת ספרים", google: "Google Books", manual: "הוזן ידנית" };
/** Loan history actions (Loan.log). */
const LOAN_LOG_ACTIONS = ["lent", "extended", "returned", "note"];

/**
 * Error policy (decided, not open): stable English CODES on the wire +
 * Hebrew labels defined once here. Controllers throw AppError.of(CODE).
 */
const ERROR_CODES = {
  NOT_FOUND: "לא נמצא",
  MISSING_FIELDS: "חסרים שדות חובה",
  INVALID_DATE: "תאריך לא חוקי",
  INVALID_STAGE: "שלב לא חוקי בצנרת הקליטה",
  INVALID_STATUS: "סטטוס לא חוקי",
  DUPLICATE_ENROLLMENT: "הסטודנט כבר משובץ במחזור הזה",
  CYCLE_FULL: "אין מקום פנוי במחזור",
  WORLD_MISMATCH: "הרשומה שייכת לעולם נתונים אחר — החליפו מתג נתונים",
  ARCHIVE_READONLY: "שיעור ארכיוני — לקריאה בלבד",
  REFERENCED_BLOCKED: "אי אפשר למחוק — קיימות רשומות שמפנות לכאן",
  SLOT_NOT_FOUND: "המפגש המבוקש לא קיים במחזור הזה",
  EMAIL_TAKEN: "האימייל כבר קיים במערכת",
  PERSON_DELETED: "האדם הזה הועבר לארכיון",
  INVALID_KIND: "סוג פרופיל לא מוכר",
  PROFILE_EXISTS: "לאדם הזה כבר יש פרופיל מהסוג הזה",
  NO_STUDENT_PROFILE: "לאדם הזה אין פרופיל סטודנט",
  PROFILE_INACTIVE: "הפרופיל הזה סגור",
  PROFILE_ACTIVE: "הפרופיל הזה כבר פעיל",
  INVALID_TRANSFER: "מעבר לא חוקי בין תוכניות",
  NO_ACTOR: "חובה לציין מי מבצע/ת את הפעולה",
  NOT_CULTURE_STAFF: "הפעולה הזו שמורה לצוות תרבות לכל",
  NOT_CULTURE_STUDENT: "לאדם הזה אין פרופיל פעיל בתרבות לכל",
  EVENT_NOT_OPEN: "האירוע לא פתוח להרשמה",
  EVENT_FULL: "אין מקום פנוי באירוע",
  DUPLICATE_REGISTRATION: "הסטודנט/ית כבר רשום/ה לאירוע הזה",
  NOT_ELIGIBLE: "הסטודנט/ית לא עומד/ת בהגדרות האירוע",
  REGISTRATION_CLOSED: "הרישום הזה כבר בוטל",
  EVENT_NOT_HELD: "אי אפשר לדווח נוכחות לפני מועד האירוע",
  VOUCHER_TAKEN: "השובר הזה כבר ניתן למישהו",
  VOUCHER_NOT_GRANTED: "השובר הזה עדיין לא ניתן לאף אחד",
  VOUCHER_REDEEMED: "השובר הזה כבר מומש",
  VOUCHER_NUMBER_TAKEN: "מספר השובר כבר קיים",
  // קליטה (אינטייק) + דף הנחיתה
  NO_PROGRAM: "יש לבחור לפחות תוכנית אחת",
  INVALID_PHONE: "מספר הטלפון לא תקין",
  INTAKE_LINK_INVALID: "הקישור אינו תקף",
  INTAKE_NOT_SCHEDULED: "עדיין לא נקבע מועד לאינטייק",
  INTAKE_ALREADY_DONE: "האינטייק כבר בוצע",
  INTAKE_COMPLETE: "הקליטה כבר הושלמה",
  APPROVAL_DATE_REQUIRED: "לאישור שקדייה חובה לשייך תאריך תוקף",
  DOCUMENT_UNKNOWN: "סוג מסמך לא מוכר",
  DOCUMENT_INVALID: "הקובץ לא נתמך — מותר PDF או תמונה עד 8MB",
  DOCUMENT_LOCKED: "המסמך כבר אושר ע\"י הצוות ואי אפשר להחליף אותו",
  SPAM_REJECTED: "הבקשה נדחתה",
  // הספרייה
  BARCODE_INVALID: "ברקוד לא תקין",
  BOOK_EXISTS: "הספר עם הברקוד הזה כבר קיים בספרייה",
  BOOK_ON_LOAN: "הספר מושאל כרגע — קודם צריך להחזיר אותו",
  BOOK_AVAILABLE: "הספר לא מושאל לאף אחד",
  LOAN_CLOSED: "ההשאלה הזו כבר הוחזרה",
  DUE_DATE_INVALID: "תאריך ההחזרה חייב להיות תאריך עתידי",
  DUE_DATE_CLOSED: "הספרייה סגורה בשישי ובשבת — בחרו יום אחר",
  DUE_DATE_TOO_FAR: "תאריך ההחזרה רחוק מדי",
  DUE_DATE_NOT_LATER: "הארכה חייבת לקבוע תאריך מאוחר מהנוכחי",
  COVER_INVALID: "תמונת הכריכה לא נתמכת — מותר JPG / PNG / WebP עד 3MB",
  LOOKUP_FAILED: "החיפוש באינטרנט נכשל — אפשר להזין את פרטי הספר ידנית",
};

/**
 * The single payload GET /api/meta/domain serves — the client renders
 * labels from this instead of maintaining mirror tables.
 */
const DOMAIN_META = {
  worlds: WORLDS.map((k) => ({ key: k, label: WORLD_LABELS[k] })),
  profileKinds: PROFILE_KINDS,
  studentKinds: STUDENT_KINDS,
  programs: PROGRAMS,
  profileEvents: PROFILE_EVENTS,
  eventCategoryGroups: EVENT_CATEGORY_GROUPS,
  eventCategories: EVENT_CATEGORIES,
  eventStatuses: EVENT_STATUSES.map((k) => ({ key: k, label: EVENT_STATUS_LABELS[k] })),
  eventGenderScopes: EVENT_GENDER_SCOPES.map((k) => ({ key: k, label: EVENT_GENDER_LABELS[k] })),
  registrationStatuses: REGISTRATION_STATUSES.map((k) => ({ key: k, label: REGISTRATION_STATUS_LABELS[k] })),
  registrationActions: REGISTRATION_ACTIONS,
  pipelineStages: PIPELINE_STAGES,
  legacyStageMap: LEGACY_STAGE_MAP,
  intakeStages: INTAKE_STAGES,
  preIntakeStages: PRE_INTAKE_STAGES,
  intakeDocuments: INTAKE_DOCUMENTS,
  documentStatuses: DOCUMENT_STATUSES.map((k) => ({ key: k, label: DOCUMENT_STATUS_LABELS[k] })),
  intakeStatuses: INTAKE_STATUSES.map((k) => ({ key: k, label: INTAKE_STATUS_LABELS[k] })),
  intakeSwStatuses: INTAKE_SW_STATUSES.map((k) => ({ key: k, label: INTAKE_SW_STATUS_LABELS[k] })),
  intakeFilledBy: INTAKE_FILLED_BY,
  dayParts: DAY_PARTS,
  attendanceStatuses: ATTENDANCE_STATUSES.map((k) => ({ key: k, label: ATTENDANCE_LABELS[k] })),
  cycleStatuses: CYCLE_STATUSES.map((k) => ({ key: k, label: CYCLE_STATUS_LABELS[k] })),
  enrollmentStatuses: ENROLLMENT_STATUSES.map((k) => ({ key: k, label: ENROLLMENT_STATUS_LABELS[k] })),
  functioningLevels: FUNCTIONING_LEVELS.map((k) => ({ key: k, label: FUNCTIONING_LABELS[k] })),
  groupPreferences: GROUP_PREFERENCES,
  subjectCategories: SUBJECT_CATEGORIES,
  library: LIBRARY,
  bookSources: BOOK_SOURCES.map((k) => ({ key: k, label: BOOK_SOURCE_LABELS[k] })),
  errorCodes: ERROR_CODES,
};

module.exports = {
  ATTENDANCE_STATUSES,
  ATTENDANCE_LABELS,
  PIPELINE_STAGES,
  PIPELINE_STAGE_KEYS,
  LEGACY_STAGE_MAP,
  INTAKE_STAGES,
  PRE_INTAKE_STAGES,
  INTAKE_DOCUMENTS,
  INTAKE_DOCUMENT_KEYS,
  INTAKE_REQUIRED_DOCUMENTS,
  INTAKE_APPROVALS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_OK_STATUSES,
  INTAKE_STATUSES,
  INTAKE_STATUS_LABELS,
  INTAKE_SW_STATUSES,
  INTAKE_SW_STATUS_LABELS,
  INTAKE_FILLED_BY,
  INTAKE_FILLED_BY_KEYS,
  INTAKE_SOURCES,
  INTAKE_LOG_ACTIONS,
  DAY_PARTS,
  FUNCTIONING_LEVELS,
  FUNCTIONING_LABELS,
  GROUP_PREFERENCES,
  HOSTELS,
  WORLDS,
  WORLD_LABELS,
  PROFILE_KINDS,
  PROFILE_KIND_KEYS,
  STUDENT_KINDS,
  PROGRAMS,
  PROGRAM_LABELS,
  PROFILE_EVENTS,
  PROFILE_EVENT_KEYS,
  EVENT_CATEGORY_GROUPS,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_KEYS,
  EVENT_STATUSES,
  EVENT_STATUS_LABELS,
  EVENT_GENDER_SCOPES,
  EVENT_GENDER_LABELS,
  REGISTRATION_STATUSES,
  REGISTRATION_STATUS_LABELS,
  REGISTRATION_ACTIONS,
  REGISTRATION_ACTION_KEYS,
  CYCLE_STATUSES,
  CYCLE_STATUS_LABELS,
  ENROLLMENT_STATUSES,
  ENROLLMENT_STATUS_LABELS,
  OCCUPYING_STATUSES,
  SUBJECT_CATEGORIES,
  SUBJECT_CATEGORY_KEYS,
  LIBRARY,
  BOOK_SOURCES,
  BOOK_SOURCE_LABELS,
  LOAN_LOG_ACTIONS,
  ERROR_CODES,
  DOMAIN_META,
};
