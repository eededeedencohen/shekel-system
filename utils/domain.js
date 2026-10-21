/**
 * @file Shared domain constants
 * @module utils/domain
 *
 * Single source of truth for cross-cutting enums. English keys are what is
 * stored in the DB and travels over the wire; Hebrew labels are shipped
 * alongside so clients render labels without their own mapping tables.
 */

/**
 * Attendance statuses (exactly three - anything else is inferred, not stored):
 *  - Present          = נכח    - attended the lesson.
 *  - AnnouncedAbsence = לא נכח - announced in advance they would not attend.
 *  - Missing          = נעדר   - did not show and whereabouts unknown (concerning).
 * A past date with no record simply means "not reported" and is never stored.
 */
const ATTENDANCE_STATUSES = ["Present", "AnnouncedAbsence", "Missing"];

const ATTENDANCE_LABELS = {
  Present: "נכח",
  AnnouncedAbsence: "לא נכח",
  Missing: "נעדר",
};

/**
 * The מכללה לכל pipeline - Eden's spec (2026-09-17), which replaced the
 * eight keys of the 2026-09-09 diagram with five stops and one side door:
 *
 *   landing page / "+ מתעניין חדש" ──► Interested   tag "מתעניין במכללה לכל"
 *   נועה/חגי move it BY HAND       ──► Matching     waiting for a cycle
 *   a seat is RESERVED (cycle only, ──► Intake       "קליטה אצל העובדת סוציאלית":
 *     no start date)                                  automatic - enrollmentService
 *       ייטב: שיחה ראשונית → בהמתנה לאינטייק → בוצע אינטייק,
 *       + אישור שקדייה + the four documents - all on the `intakes` record
 *   the file is complete           ──► AwaitingPlacement  automatic - intakeService:
 *                                                  the baton is back with the managers,
 *                                                  a seat is held, the start date is missing
 *   נועה/חגי enter the start date  ──► Placed       automatic - enrollmentService
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
/** The social worker's turf - college managers may not move this. */
const INTAKE_STAGES = ["Intake"];
/** Stages a person is in BEFORE the intake begins. */
const PRE_INTAKE_STAGES = ["Interested", "Matching"];

/* ───────────────────────── קליטה (אינטייק) ───────────────────────── */

/**
 * The intake file - the documents the social worker listed (2026-10-07):
 * the THREE she requires, with the validity each one carries, plus the
 * social-club letter as an optional extra (she never mentioned it; Eden
 * keeps it until she says otherwise). The tag on the student reads "X מתוך
 * 3 מסמכים התקבלו" / "כל המסמכים התקבלו".
 *
 *   validity "dated"   the report names its own expiry (6 months - 2 years):
 *                      the coordinator types the exact date when she
 *                      receives it (DOCUMENT_DATE_REQUIRED); expired = open
 *                      again, alerted FOLLOW_UP.psychiatricNoticeDays ahead
 *   validity "signed"  valid exactly FOLLOW_UP.waiverMonths from the
 *                      signature - computed, never typed; expired = no
 *                      sharing with outsiders, alerted waiverNoticeDays ahead
 *
 * "אישור שקדייה" is NOT a document any more: there is no approval that
 * arrives from outside - the coordinator ENTERS the person in שקדיה and
 * marks it here with the date (`intake.shkedia`). The file is complete
 * when the intake was held, שקדיה was entered and every required document
 * is in and in force.
 */
const INTAKE_DOCUMENTS = [
  { key: "psychiatric", label: "דוח פסיכיאטרי", hint: "עדכני, חתום ע\"י פסיכיאטר/ית - עם תאריך התוקף הנקוב בו", upload: true, validity: "dated" },
  { key: "psychosocial", label: "דוח פסיכוסוציאלי", hint: "מהעו\"ס המלווה - עם פרטי הקשר שלו/ה", upload: true },
  { key: "waiver", label: "טופס ויתור סודיות", hint: "נחתם בפגישת האינטייק או מועלה חתום · בתוקף שנה מהחתימה", upload: true, validity: "signed" },
  { key: "socialClub", label: "אישור מועדון חברתי", hint: "אם יש", upload: true, optional: true },
];
const INTAKE_DOCUMENT_KEYS = INTAKE_DOCUMENTS.map((d) => d.key);
/** The documents behind the "מסמכים" tag (the optional one is not counted). */
const INTAKE_REQUIRED_DOCUMENTS = INTAKE_DOCUMENTS.filter((d) => !d.optional);
/** Legacy keys that may still sit on old records - dropped on save, migrated by scripts/migrateShkedia.js. */
const RETIRED_DOCUMENT_KEYS = ["shkedia"];

/**
 * The cadences the social worker set (2026-10-07) - every alert in the app
 * is DERIVED from dates with these numbers; nothing is stored as a reminder.
 */
const FOLLOW_UP = {
  /** שיחת מעקב: every 3 months from the last one (or the admission); shown 4 weeks ahead. */
  followUpMonths: 3,
  followUpNoticeDays: 28,
  /** שיחת הערכה: every 24 months from the rehab-committee date (else the שקדיה admission); shown ~2 months ahead. */
  evaluationMonths: 24,
  evaluationNoticeDays: 60,
  /** ויתור סודיות: exactly a year from the signature; shown 45 days ahead. */
  waiverMonths: 12,
  waiverNoticeDays: 45,
  /** דוח פסיכיאטרי: its own date; shown 60 days ahead. */
  psychiatricNoticeDays: 60,
  /** אינטייק בעיכוב: this many days at the social worker's stage without a held meeting. */
  intakeDelayDays: 14,
  /** שיחה ראשונה: within 48 hours of the lead. */
  firstCallHours: 48,
  /** בהמתנה: a warm call every month, never more than 60 days without a refresh. */
  waitlistContactDays: 30,
  waitlistRefreshDays: 60,
};

/** The screening facts of the first call (her stage 1). */
const SCREENING_ELIGIBILITY = [
  { key: "yes", label: "זכאי/ת לסל שיקום" },
  { key: "no", label: "לא זכאי/ת" },
  { key: "unknown", label: "עדיין לא ברור" },
];
const SCREENING_ELIGIBILITY_KEYS = SCREENING_ELIGIBILITY.map((e) => e.key);
const SCREENING_INTERESTS = [
  { key: "college", label: "מכללה לכל" },
  { key: "culture", label: "תרבות לכל" },
  { key: "socialClub", label: "מועדון חברתי" },
  { key: "hostels", label: "הוסטל" },
];
const SCREENING_INTEREST_KEYS = SCREENING_INTERESTS.map((i) => i.key);

/** How long a temporary upload link lives (minutes) - the coordinator picks one. */
const UPLOAD_LINK_MINUTES = [
  { key: 10, label: "10 דקות" },
  { key: 30, label: "חצי שעה" },
  { key: 60, label: "שעה" },
  { key: 1440, label: "24 שעות" },
];
/** The personal link the landing page hands out lives this long after a submission. */
const LANDING_LINK_HOURS = 24;

/* ───────────────────────── ספקים (פתיחת תיק ספק) ───────────────────────── */

/**
 * Opening a supplier (Eden, 2026-10-14, the paper form "פתיחת תיק ספק -
 * עמותת שק״ל"): the coordinator makes a link, the supplier fills the
 * form and uploads the certificates on their phone, the coordinator checks
 * every item (תקין / לא תקין), generates the summary and sends the mail.
 */
const SUPPLIER_GENDERS = [
  { key: "female", label: "אישה" },
  { key: "male", label: "גבר" },
  { key: "other", label: "אחר" },
];
const SUPPLIER_GENDER_KEYS = SUPPLIER_GENDERS.map((g) => g.key);
/** How long the supplier's link stays open (days) - the coordinator picks. */
const SUPPLIER_LINK_DAYS = [
  { key: 3, label: "3 ימים" },
  { key: 7, label: "שבוע" },
  { key: 14, label: "שבועיים" },
  { key: 30, label: "חודש" },
];
/** The certificates the paper form asks for; the fourth only "במידת הצורך". */
const SUPPLIER_FILES = [
  { key: "books", label: "אישור ניהול ספרים", required: true },
  { key: "withholding", label: "אישור ניכוי מס במקור", required: true },
  { key: "bankProof", label: "צילום צ'ק או אישור בנק על החשבון", required: true },
  { key: "exempt", label: "אישור עוסק פטור", required: false, hint: "במידת הצורך" },
];
const SUPPLIER_FILE_KEYS = SUPPLIER_FILES.map((f) => f.key);
/** The form's fields; `required` = the asterisk on the paper. */
const SUPPLIER_FIELDS = [
  { key: "companyName", label: "שם חברה / מוסד" },
  { key: "businessId", label: "מספר עוסק מורשה", required: true },
  { key: "address", label: "כתובת" },
  { key: "officePhone", label: "טלפון משרד" },
  { key: "contactName", label: "שם איש קשר" },
  { key: "contactPhone", label: "טלפון סלולרי איש קשר", required: true },
  { key: "contactEmail", label: "מייל איש קשר", required: true },
  { key: "accountOwners", label: "שם בעלי החשבון" },
  { key: "bank", label: "בנק", required: true },
  { key: "branch", label: "סניף", required: true },
  { key: "accountNumber", label: "מספר חשבון", required: true },
];
const SUPPLIER_FIELD_KEYS = SUPPLIER_FIELDS.map((f) => f.key);
/** Fixed for every supplier - the form shows it, nobody edits it. */
const SUPPLIER_PAYMENT_TERMS = "שוטף + 60";
/**
 * Where a supplier stands (computed from the facts, never set by hand):
 *   link      the link exists, the form was not sent yet
 *   filling   the form or files are still missing, or something was marked לא תקין
 *   review    everything is in - the coordinator checks
 *   approved  everything תקין - waiting for the mail ("הועלו קבצים")
 *   done      the mail was sent
 */
const SUPPLIER_STATUSES = ["link", "filling", "review", "approved", "done"];
const SUPPLIER_STATUS_LABELS = {
  link: "נשלח קישור",
  filling: "ממלא/ת",
  review: "לבדיקה",
  approved: "הכול תקין · ממתין למייל",
  done: "נשלח מייל",
};
const SUPPLIER_REVIEW_STATES = ["pending", "ok", "bad"];

/* ───────────────────────── שמרית's round (2026-10-19) ───────────────────────── */

/**
 * A hostel is a house people live in; a קהילה (independent housing) is a
 * framework people come to - reported as attendance in שקדיה, NOT to the
 * Ministry of Health as a hostel (שמרית, 2026-10-14). The kind is a label
 * and a filter, never a colour.
 */
const HOSTEL_KINDS = [
  { key: "hostel", label: "הוסטל" },
  /** Her table (2026-10-19): "מצפה רעות הוסטל וקהילה תומכת" - a house people live in that also holds a supportive community; a hostel for the Ministry. */
  { key: "both", label: "הוסטל וקהילה" },
  { key: "community", label: "קהילה" },
];
const HOSTEL_KIND_KEYS = HOSTEL_KINDS.map((k) => k.key);
/** Two to three people per hostel (שמרית): the manager, who reports the attendance, the care coordinator. */
const HOSTEL_CONTACT_ROLES = [
  { key: "manager", label: "מנהל/ת ההוסטל" },
  { key: "reporter", label: "איש/אשת קשר לדיווח" },
  { key: "coordinator", label: "מתאם/ת טיפול" },
  { key: "other", label: "אחר" },
];
const HOSTEL_CONTACT_ROLE_KEYS = HOSTEL_CONTACT_ROLES.map((r) => r.key);
/** A person's own papers (a teacher's syllabus first; "תיק" on the teacher page). */
const PERSON_DOCUMENT_KINDS = [
  { key: "syllabus", label: "סילבוס" },
  { key: "other", label: "מסמך אחר" },
];
const PERSON_DOCUMENT_KIND_KEYS = PERSON_DOCUMENT_KINDS.map((k) => k.key);
/**
 * The monthly invoice round: every teacher of the program's live courses
 * gets a temporary link for the month - marks which sessions took place,
 * uploads the invoice, done. Hostels first (Eden, 2026-10-14: "בינתיים
 * נצמצם את זה רק להוסטלים"); the college when its lessons are in sync.
 */
const INVOICE_ROUND_PROGRAMS = ["hostels", "college"];
const INVOICE_ROUND_PROGRAM_LABELS = { hostels: "הוסטלים", college: "מכללה לכל" };
/** How long a teacher's link stays open, days - and the renewal step. */
const INVOICE_LINK_DAYS = 21;
/** Kept on InvoiceRequest.sessions for the rows written before 2026-10-21; the teacher marks nothing any more - the invoice names its sessions. */
const INVOICE_SESSION_STATES = ["taught", "notHeld"];
/**
 * Where a teacher's request stands (computed, never set by hand):
 *   new      opened, the link not yet sent
 *   sent     sent, not opened
 *   opened   opened, no invoice yet
 *   partial  an invoice came in, not finished
 *   done     the teacher pressed "סיימתי"
 */
const INVOICE_REQUEST_STATUSES = ["new", "sent", "opened", "partial", "done"];
const INVOICE_REQUEST_STATUS_LABELS = {
  new: "עוד לא נשלח",
  sent: "נשלח · לא נפתח",
  opened: "נפתח",
  partial: "חלקי",
  done: "הושלם",
};
/** A diary entry is a note on a day, or a task that is done or not (שמרית's יומן). */
const DIARY_KINDS = ["note", "task"];
/** The day of the month by which the teachers' invoices must be in (שמרית, 2026-10-19: "ב-29 לחודש החשבוניות צריכות להיות אצלי כבר"). */
const INVOICE_DUE_DAY = 29;

/**
 * Why someone missed a session (שמרית, 2026-10-14 and her answer of
 * 2026-10-19: her fear is a false report to the Ministry of Health, so an
 * absence from a hostel course carries its reason). "עזב/ה את ההוסטל" is
 * NOT a reason - it is the resident's dates (residence.until).
 */
const ABSENCE_REASONS = [
  { key: "hospital", label: "אשפוז" },
  { key: "er", label: "מיון" },
  { key: "vacation", label: "חופשה" },
  { key: "refused", label: "סירב/ה" },
  { key: "unexplained", label: "נעדר/ת ללא הסבר" },
  { key: "incident", label: "אירוע חריג" },
  { key: "other", label: "אחר" },
];
const ABSENCE_REASON_KEYS = ABSENCE_REASONS.map((r) => r.key);
/**
 * The hostel's own attendance draft (phase 3 of שמרית's round): a month's
 * link to the house's contact, who marks every session - held or not, who
 * came, why someone did not, a resident the list lacks, one who left. A
 * DRAFT: nothing reaches the attendance until the coordinator approves.
 */
const HOSTEL_REPORT_LINK_DAYS = 14; // after the month's last day (and never less than this from the opening)
const HOSTEL_REPORT_SESSION_STATES = ["held", "notHeld"];
const HOSTEL_REPORT_MARKS = ["present", "absent"];
/** Where a hostel's month stands (computed): new → sent → opened → partial → done (submitted) → approved (every marked session approved). */
const HOSTEL_REPORT_STATUSES = ["new", "sent", "opened", "partial", "done", "approved"];
const HOSTEL_REPORT_STATUS_LABELS = {
  new: "עוד לא נשלח",
  sent: "נשלח · לא נפתח",
  opened: "נפתח",
  partial: "חלקי",
  done: "הוגש",
  approved: "אושר",
};

/* ───────────────────────── פעילויות (the person's record) ───────────────────────── */

/**
 * The activities tab (the social worker, 2026-10-07): every event in a
 * person's life with us, in order - each kind with the template the
 * coordinator starts from (editable per world: ActivityTemplate). `resets`
 * says which periodic clock saving this kind restarts (lib/followups).
 */
const ACTIVITY_KINDS = [
  { key: "firstCall", label: "שיחה ראשונית", short: "שיחה ראשונית" },
  { key: "intake", label: "אינטייק", short: "אינטייק" },
  { key: "followUp", label: "שיחת מעקב", short: "מעקב", resets: "followUp" },
  { key: "evaluation", label: "שיחת הערכה", short: "הערכה", resets: "evaluation" },
  { key: "hospitalization", label: "אשפוז", short: "אשפוז" },
  { key: "update", label: "עדכון כללי", short: "עדכון" },
  { key: "closure", label: "דוח סיום התקשרות", short: "דוח סיום" },
  { key: "leave", label: "דיווח עזיבה", short: "עזיבה" },
  { key: "incident", label: "אירוע חריג", short: "אירוע חריג" },
  { key: "waiver", label: "ויתור סודיות", short: "ויתור סודיות" },
];
const ACTIVITY_KIND_KEYS = ACTIVITY_KINDS.map((k) => k.key);

/**
 * ויתור סודיות (Eden, 2026-10-11, after the old system's form): the
 * parties the person lets שק"ל exchange information with. The first two
 * are required on the form; `other` rows are free.
 */
const WAIVER_PARTIES = [
  { key: "psychiatrist", label: "פסיכיאטר/ית מלווה", required: true },
  { key: "emergency", label: "איש קשר לשעת חירום", required: true, phone: true },
  { key: "coordinator", label: "מתאם/ת טיפול", phone: true },
  { key: "housing", label: "דיור" },
  { key: "socialClub", label: "מועדון חברתי" },
  { key: "employment", label: "תעסוקה" },
  { key: "familyDoctor", label: "רופא/ת משפחה" },
  { key: "education", label: "השכלה" },
  { key: "other", label: "אחר" },
];
const WAIVER_PARTY_KEYS = WAIVER_PARTIES.map((p) => p.key);
const ACTIVITY_FIELD_TYPES = ["text", "textarea", "select", "checkbox", "date"];

/**
 * The templates she described, as the starting point of every world. A
 * coordinator edits them in the app (PUT /api/activities/templates/:kind);
 * a world without a stored template gets this one.
 */
const DEFAULT_ACTIVITY_TEMPLATES = {
  firstCall: {
    title: "שיחה ראשונית",
    body: "מי פנה ואיך הגיע אלינו:\nמה מחפש/ת אצלנו:\nסיכום:",
    fields: [
      { key: "eligibility", label: "זכאות לסל שיקום", type: "select", options: SCREENING_ELIGIBILITY.map((e) => e.key), required: true },
      { key: "interests", label: "תחומי עניין", type: "text" },
    ],
  },
  intake: {
    title: "אינטייק",
    body: "",
    fields: [
      { key: "background", label: "רקע תפקודי", type: "textarea", required: true },
      { key: "expectations", label: "ציפיות", type: "textarea", required: true },
      { key: "goals", label: "יעדים שיקומיים", type: "textarea", required: true },
      { key: "treating", label: "גורמים מטפלים", type: "textarea", required: true },
    ],
  },
  followUp: {
    title: "שיחת מעקב",
    body: "איך הולך בקורסים / באירועים?\nמה טוב?\nמה קשה?\nיש משהו שהיית רוצה לשנות?",
    fields: [
      { key: "attendance", label: "נוכחות", type: "select", options: ["סדירה", "חלקית", "לא מגיע/ה"], required: true },
      { key: "motivation", label: "מוטיבציה", type: "select", options: ["גבוהה", "בינונית", "נמוכה"] },
      { key: "impression", label: "התרשמות כללית", type: "textarea", required: true },
      { key: "next", label: "יעדים לפעם הבאה", type: "textarea" },
    ],
  },
  evaluation: {
    title: "שיחת הערכה",
    body: "",
    fields: [
      { key: "progress", label: "התקדמות אישית", type: "textarea", required: true },
      { key: "occupational", label: "התקדמות תעסוקתית / לימודית", type: "textarea" },
      { key: "goals", label: "יעדים שיקומיים להמשך", type: "textarea", required: true },
      { key: "shkediaUpdate", label: "דורש עדכון בשקדיה", type: "checkbox" },
    ],
  },
  hospitalization: {
    title: "אשפוז",
    body: "",
    fields: [
      { key: "where", label: "איפה", type: "text" },
      { key: "from", label: "מתאריך", type: "date", required: true },
      { key: "to", label: "עד תאריך", type: "date" },
      { key: "contact", label: "איש קשר במחלקה", type: "text" },
    ],
  },
  update: { title: "עדכון כללי", body: "", fields: [] },
  closure: {
    title: "דוח סיום התקשרות",
    body: "",
    fields: [
      { key: "process", label: "תהליך השיקום אצלנו", type: "textarea", required: true },
      { key: "achievements", label: "הישגים", type: "textarea", required: true },
      { key: "reasons", label: "הסיבות לסיום", type: "textarea", required: true },
      { key: "recommendations", label: "המלצות להמשך הדרך", type: "textarea", required: true },
    ],
  },
  leave: { title: "דיווח עזיבה", body: "", fields: [] },
  incident: { title: "אירוע חריג", body: "", fields: [] },
  waiver: { title: "ויתור סודיות", body: "", fields: [] },
};

/** דיווח עזיבה - the reason picked from a closed list (free text beside it). */
const LEAVE_REASONS = [
  { key: "completed", label: "סיים/ה את התוכנית" },
  { key: "moved", label: "עבר/ה למסגרת אחרת" },
  { key: "health", label: "מצב בריאותי" },
  { key: "noShow", label: "הפסיק/ה להגיע" },
  { key: "request", label: "לבקשתו/ה" },
  { key: "eligibility", label: "סיום הזכאות" },
  { key: "other", label: "אחר" },
];
const LEAVE_REASON_KEYS = LEAVE_REASONS.map((r) => r.key);

/* ───────────────────────── אירועים חריגים ───────────────────────── */

/** The Ministry of Health form's classifications (primary → secondary). */
const INCIDENT_PRIMARY = [
  { key: "physical", label: "פגיעה פיזית", secondary: ["נפילה", "פציעה בפעילות", "פגיעה עצמית", "אחר"] },
  { key: "violence", label: "אלימות", secondary: ["אלימות מילולית", "אלימות פיזית", "איום", "פגיעה ברכוש", "אחר"] },
  { key: "medical", label: "התדרדרות רפואית", secondary: ["התקף", "מצב נפשי חריף", "אובדנות", "אשפוז דחוף", "אחר"] },
  { key: "other", label: "אחר", secondary: ["היעדרות בלתי מוסברת", "אובדן קשר", "אחר"] },
];
const INCIDENT_PRIMARY_KEYS = INCIDENT_PRIMARY.map((p) => p.key);

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
 *   new        - no call yet
 *   scheduled  - the meeting is set ("בהמתנה לאינטייק")
 *   documents  - the meeting was held; שקדיה and/or documents are missing (or expired)
 *   complete   - held + entered in שקדיה + every required document in force
 */
const INTAKE_STATUSES = ["new", "scheduled", "documents", "complete"];
const INTAKE_STATUS_LABELS = {
  new: "טרם בוצעה שיחה ראשונית",
  scheduled: "בהמתנה לאינטייק",
  documents: "בוצע אינטייק · משלימים תיק",
  complete: "הקליטה הושלמה",
};
/**
 * The "סטטוס עובדת סוציאלית" tag on a student (Eden's three values) -
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
  // 2026-10-07 - the social worker's round
  "shkedia", "coordinator", "screening", "committee", "link",
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
 * Known hostel names. Used to validate imports only - CourseInstance.hostel
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
 * collection, injected by server middleware from the X-Dataset header -
 * never taken from a request body. "real" is the default.
 */
const WORLDS = ["real", "pokemon", "test"];
const WORLD_LABELS = { real: "אמיתי", pokemon: "פוקימון", test: "טסט" };

/**
 * Profile kinds - the user types of the identity+profiles split. A person
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
 * The PROGRAMS a student can belong to - exactly the student kinds, with
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
 * Profile lifecycle events - the append-only `log` on every profile.
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
 * Culture-event categories (English keys in the DB) - the vocabulary of the
 * real "יציאות בקהילה" senzey data, at the grain Eden asked for (2026-09-07:
 * "אני ממש רוצה להבדיל בין סטנדאפ למופע של זמר והצגה"): every kind of
 * performance is its own category, restaurants are not bowling, a museum
 * is not a hike. `group` only organises the pick-list (optgroups) and the
 * legend; `hint` is the pick-list's parenthesis. The pre-split keys
 * (`show`, `outing`, `trip`…) stay valid so stored events never break -
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
 * Event-registration states - ONE record per (event, student):
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
 * Enrollment states - the ONE definition of occupancy:
 *  reserved  = seat held by Noa during intake (counts against capacity)
 *  active    = enrolled and attending
 *  completed = finished the cycle (graduated - distinct from dropping out)
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
 * Subject taxonomy categories - English keys in the DB, Hebrew labels here.
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
 * הספרייה - books lent to students. ONE copy per book (Eden, 2026-09-09),
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
  WORLD_MISMATCH: "הרשומה שייכת לעולם נתונים אחר - החליפו מתג נתונים",
  ARCHIVE_READONLY: "שיעור ארכיוני - לקריאה בלבד",
  REFERENCED_BLOCKED: "אי אפשר למחוק - קיימות רשומות שמפנות לכאן",
  EVENT_NOT_DRAFT: "אירוע שפורסם אי אפשר למחוק - אפשר לבטל אותו",
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
  INTAKE_LINK_EXPIRED: "הקישור פג - בקשו מהרכזת קישור חדש",
  INTAKE_NOT_SCHEDULED: "עדיין לא נקבע מועד לאינטייק",
  INTAKE_ALREADY_DONE: "האינטייק כבר בוצע",
  INTAKE_COMPLETE: "הקליטה כבר הושלמה",
  DOCUMENT_DATE_REQUIRED: "למסמך הזה חובה לשייך את תאריך התוקף הנקוב בו",
  SHKEDIA_DATE_REQUIRED: "לקליטה בשקדיה חובה תאריך",
  LINK_MINUTES_INVALID: "משך הקישור חייב להיות 10 דקות, חצי שעה, שעה או 24 שעות",
  DOCUMENT_UNKNOWN: "סוג מסמך לא מוכר",
  // פעילויות ואירועים חריגים
  ACTIVITY_KIND_UNKNOWN: "סוג פעילות לא מוכר",
  ACTIVITY_FIELD_REQUIRED: "חסר שדה חובה בפעילות",
  TEMPLATE_INVALID: "התבנית לא תקינה",
  INCIDENT_INVALID: "בדיווח אירוע חריג חסרים פרטים: מתי, מי דיווח, סיווג ותיאור",
  LEAVE_REASON_INVALID: "סיבת העזיבה לא מוכרת",
  DOCUMENT_INVALID: "הקובץ לא נתמך - מותר PDF, תמונה או Word עד 8MB",
  WAIVER_INVALID: "אי אפשר לשמור את ויתור הסודיות - חסר",
  DOCUMENT_LOCKED: "המסמך כבר אושר ע\"י הצוות ואי אפשר להחליף אותו",
  SPAM_REJECTED: "הבקשה נדחתה",
  // הספרייה
  BARCODE_INVALID: "ברקוד לא תקין",
  BOOK_EXISTS: "הספר עם הברקוד הזה כבר קיים בספרייה",
  BOOK_ON_LOAN: "הספר מושאל כרגע - קודם צריך להחזיר אותו",
  BOOK_AVAILABLE: "הספר לא מושאל לאף אחד",
  LOAN_CLOSED: "ההשאלה הזו כבר הוחזרה",
  DUE_DATE_INVALID: "תאריך ההחזרה חייב להיות תאריך עתידי",
  DUE_DATE_CLOSED: "הספרייה סגורה בשישי ובשבת - בחרו יום אחר",
  DUE_DATE_TOO_FAR: "תאריך ההחזרה רחוק מדי",
  DUE_DATE_NOT_LATER: "הארכה חייבת לקבוע תאריך מאוחר מהנוכחי",
  COVER_INVALID: "תמונת הכריכה לא נתמכת - מותר JPG / PNG / WebP / GIF / AVIF עד 3MB",
  LOOKUP_FAILED: "החיפוש באינטרנט נכשל - אפשר להזין את פרטי הספר ידנית",
  // חשבוניות של מורים
  INVOICE_IMAGE_INVALID: "תמונת החשבונית לא נתמכת - מותר JPG / PNG / WebP / GIF / AVIF עד 8MB",
  INVOICE_NO_LESSONS: "חשבונית חייבת לפחות שיעור אחד",
  INVOICE_NOT_A_TEACHER: "חשבונית אפשר להעלות רק למורה פעיל",
  INVOICE_LESSON_NOT_TEACHERS: "אחד השיעורים שסומנו לא של המורה הזה",
  INVOICE_LESSON_BILLED: "אחד השיעורים כבר רשום בחשבונית אחרת",
  VOUCHER_IMAGE_INVALID: "תמונת השובר לא נתמכת - מותר JPG / PNG / WebP / GIF / AVIF עד 8MB",
  VOUCHER_IMAGE_FETCH: "לא נמצאה תמונה בקישור הזה - אפשר להדביק כתובת של תמונה, או של דף שיש בו תמונה",
  // תגיות
  TAG_UNKNOWN: "תגית לא מוכרת",
  NOT_IN_PROGRAM: "הסטודנט/ית לא שייך/ת לתוכנית של המחזור",
  // זמינות מורה שסומנה לתוכנית (Eden, 2026-10-14)
  AVAILABILITY_TAKEN: "הזמן הזה כבר שמור לתוכנית אחרת",
  AVAILABILITY_LOCKED: "חלון שסומן לתוכנית אחרת אי אפשר לשנות",
  // ספקים (פתיחת תיק ספק)
  NOT_SUPPLIER_STAFF: "עמוד הספקים שמור לרכזת ההוסטלים",
  SUPPLIER_INVALID: "לספק חסרים פרטים: שם פרטי, שם משפחה, מין וטלפון",
  SUPPLIER_LINK_INVALID: "הקישור אינו תקף",
  SUPPLIER_LINK_EXPIRED: "הקישור פג - בקשו מהרכזת קישור חדש",
  SUPPLIER_LINK_DAYS_INVALID: "משך הקישור חייב להיות 3 ימים, שבוע, שבועיים או חודש",
  SUPPLIER_FORM_INVALID: "בטופס חסרים שדות חובה או שיש בו ערך לא תקין",
  SUPPLIER_FORM_LOCKED: "הטופס כבר אושר ואי אפשר לשנות אותו",
  SUPPLIER_FILE_UNKNOWN: "סוג קובץ לא מוכר",
  SUPPLIER_FILE_LOCKED: "הקובץ כבר אושר ואי אפשר להחליף אותו",
  SUPPLIER_FILE_REQUIRED: "את הקובץ הזה חובה להעלות - אי אפשר לסמן שלא רלוונטי",
  SUPPLIER_REVIEW_INVALID: "בדיקה חייבת להיות תקין או לא תקין",
  SUPPLIER_REVIEW_NOTE: "כשמשהו לא תקין חובה לכתוב מה לא תקין",
  SUPPLIER_REVIEW_FIELDS: "כשהטופס לא תקין חובה לסמן אילו שדות",
  SUPPLIER_NOTHING_TO_REVIEW: "הספק עוד לא מילא את זה",
  SUPPLIER_NOT_APPROVED: "המייל נשלח רק אחרי שהכול תקין",
  SUPPLIER_EMAIL_STEPS: "לפני \"נשלח מייל\" צריך לחולל את ה-PDF ולהעתיק את הכותרת ואת התוכן",
  SUPPLIER_DONE: "הספק כבר נקלט - המייל נשלח",
  SUPPLIER_ADMIN_ACTION: "פעולת ניהול לא מוכרת",
  SUPPLIER_PERSON_INVALID: "האדם שמקושר לתיק הספק לא נמצא",
  // סבב שמרית (2026-10-19)
  HOSTEL_KIND_INVALID: "סוג המסגרת חייב להיות הוסטל או קהילה",
  HOSTEL_CONTACT_INVALID: "לאיש קשר חובה שם ותפקיד מוכר",
  NOT_A_HOSTEL_CYCLE: "הקורס הזה אינו קורס של הוסטל",
  NO_RESIDENTS: "אין דיירים רשומים בהוסטל הזה",
  PERSON_DOCUMENT_INVALID: "הקובץ לא נתמך - מותר PDF, תמונה או Word עד 8MB",
  PERSON_DOCUMENT_KIND: "סוג מסמך לא מוכר",
  INVOICE_ROUND_PROGRAM: "סבב חשבוניות נפתח להוסטלים או למכללה לכל",
  INVOICE_ROUND_MONTH: "חודש הסבב נכתב כ-YYYY-MM",
  INVOICE_ROUND_EXISTS: "כבר נפתח סבב חשבוניות לחודש הזה",
  INVOICE_ROUND_NO_TEACHERS: "אין מורים עם קורס פעיל בחודש הזה",
  INVOICE_ROUND_HAS_INVOICES: "בסבב הזה כבר הועלו חשבוניות - אי אפשר למחוק אותו",
  INVOICE_LINK_INVALID: "הקישור אינו תקף",
  INVOICE_LINK_EXPIRED: "הקישור פג - בקשו מהרכזת קישור חדש",
  INVOICE_LINK_DONE: "הדיווח לחודש הזה כבר נסגר",
  INVOICE_SESSION_UNKNOWN: "המפגש הזה לא ברשימה של החודש",
  INVOICE_NO_SESSIONS: "בוחרים לפחות מפגש אחד שהחשבונית מכסה",
  INVOICE_NOT_YOURS: "החשבונית הזו לא הועלתה דרך הקישור הזה",
  INVOICE_DONE_EMPTY: "אפשר לסיים אחרי חשבונית אחת לפחות, או עם הערה למה אין",
  DIARY_INVALID: "לרשומה ביומן חובה תאריך וכותרת",
  ATTENDANCE_REASON_INVALID: "סיבת היעדרות לא מוכרת",
  // סקיצת הנוכחות מההוסטלים (שלב 3 של סבב שמרית)
  HOSTEL_REPORT_MONTH: "חודש הדיווח נכתב כ-YYYY-MM",
  HOSTEL_REPORT_EXISTS: "כבר נפתח דיווח להוסטל הזה לחודש הזה",
  HOSTEL_REPORT_NO_COURSES: "אין קורס פעיל בהוסטלים בחודש הזה",
  HOSTEL_REPORT_LINK_INVALID: "הקישור אינו תקף",
  HOSTEL_REPORT_LINK_EXPIRED: "הקישור פג - בקשו מהרכזת קישור חדש",
  HOSTEL_REPORT_DONE: "הדיווח לחודש הזה כבר הוגש",
  HOSTEL_REPORT_SESSION_UNKNOWN: "המפגש הזה לא ברשימה של החודש",
  HOSTEL_REPORT_SESSION_FUTURE: "המפגש עוד לא התקיים - מסמנים אותו ביום שלו",
  HOSTEL_REPORT_SESSION_STATE: "מפגש מסומן כ\"התקיים\" או \"לא התקיים\"",
  HOSTEL_REPORT_MARK_INVALID: "סימון נוכחות לא תקין",
  HOSTEL_REPORT_NOT_IN_LIST: "האדם הזה לא ברשימת הקורס",
  HOSTEL_REPORT_REASON_REQUIRED: "על מי שלא הגיע/ה חובה לסמן סיבה",
  HOSTEL_REPORT_APPROVED: "המפגש הזה כבר אושר",
  HOSTEL_REPORT_NOT_MARKED: "המפגש עוד לא סומן בהוסטל",
  HOSTEL_REPORT_HAS_APPROVED: "בדיווח הזה כבר אושרו מפגשים - אי אפשר למחוק אותו",
  HOSTEL_REPORT_EXTRA_NAME: "למי שלא ברשימה חובה שם",
  HOSTEL_REPORT_RESOLVED: "הפריט הזה כבר טופל",
  HOSTEL_REPORT_PERSON: "לא נמצא אדם כזה",
  // מסד הנתונים
  DB_FULL: "מסד הנתונים מלא - אי אפשר לשמור כרגע. צריך לפנות מקום ב-Atlas או להגדיל את החבילה",
  // כניסה וניהול משתמשים
  AUTH_REQUIRED: "צריך להיכנס למערכת",
  AUTH_FAILED: "שם המשתמש או הסיסמה לא נכונים",
  AUTH_LOCKED: "יותר מדי ניסיונות כניסה - אפשר לנסות שוב בעוד כמה דקות",
  AUTH_FORBIDDEN: "הפעולה הזו שמורה לסופר-מנהל",
  OUT_OF_SCOPE: "הנתונים האלה לא בתחום של המשתמש/ת שצופה כרגע",
  PASSWORD_WEAK: "הסיסמה צריכה לפחות 6 תווים",
  PASSWORD_WRONG: "הסיסמה הנוכחית לא נכונה",
  RESET_INVALID: "הקישור לאיפוס הסיסמה לא בתוקף - אפשר לבקש קישור חדש",
  ACCOUNT_INVALID: "חסרים פרטים למשתמש: שם, שם משתמש באנגלית ותפקיד",
  USERNAME_TAKEN: "שם המשתמש הזה כבר תפוס",
  LAST_SUPER: "חייב להישאר לפחות סופר-מנהל פעיל אחד",
};

/**
 * Staff accounts (Eden, 2026-10-12: "מעכשיו שיהיה סיסמאות למשתמשים"). The
 * kind decides what the app shows (the client's PersonaContext lens); only
 * `super` reaches the users page and the database explorer.
 */
const STAFF_KINDS = [
  { key: "super", label: "סופר-מנהל" },
  { key: "manager", label: "מנהל/ת מכללה לכל" },
  { key: "social", label: 'עובד/ת סוציאלי/ת' },
  { key: "hostels", label: "רכז/ת הוסטלים" },
  { key: "culture", label: "רכז/ת תרבות לכל" },
];
const STAFF_KIND_KEYS = STAFF_KINDS.map((k) => k.key);
/** How long a password-reset link stays open. */
const RESET_LINK_HOURS = 24;

/**
 * The single payload GET /api/meta/domain serves - the client renders
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
  // 2026-10-07 - the social worker's round
  followUp: FOLLOW_UP,
  screeningEligibility: SCREENING_ELIGIBILITY,
  screeningInterests: SCREENING_INTERESTS,
  uploadLinkMinutes: UPLOAD_LINK_MINUTES,
  landingLinkHours: LANDING_LINK_HOURS,
  activityKinds: ACTIVITY_KINDS,
  activityFieldTypes: ACTIVITY_FIELD_TYPES,
  waiverParties: WAIVER_PARTIES,
  leaveReasons: LEAVE_REASONS,
  incidentPrimary: INCIDENT_PRIMARY,
  attendanceStatuses: ATTENDANCE_STATUSES.map((k) => ({ key: k, label: ATTENDANCE_LABELS[k] })),
  cycleStatuses: CYCLE_STATUSES.map((k) => ({ key: k, label: CYCLE_STATUS_LABELS[k] })),
  enrollmentStatuses: ENROLLMENT_STATUSES.map((k) => ({ key: k, label: ENROLLMENT_STATUS_LABELS[k] })),
  functioningLevels: FUNCTIONING_LEVELS.map((k) => ({ key: k, label: FUNCTIONING_LABELS[k] })),
  groupPreferences: GROUP_PREFERENCES,
  subjectCategories: SUBJECT_CATEGORIES,
  library: LIBRARY,
  bookSources: BOOK_SOURCES.map((k) => ({ key: k, label: BOOK_SOURCE_LABELS[k] })),
  errorCodes: ERROR_CODES,
  staffKinds: STAFF_KINDS,
  resetLinkHours: RESET_LINK_HOURS,
  suppliers: {
    genders: SUPPLIER_GENDERS,
    linkDays: SUPPLIER_LINK_DAYS,
    files: SUPPLIER_FILES,
    fields: SUPPLIER_FIELDS,
    paymentTerms: SUPPLIER_PAYMENT_TERMS,
    statuses: SUPPLIER_STATUSES.map((k) => ({ key: k, label: SUPPLIER_STATUS_LABELS[k] })),
  },
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
  RETIRED_DOCUMENT_KEYS,
  FOLLOW_UP,
  SCREENING_ELIGIBILITY,
  SCREENING_ELIGIBILITY_KEYS,
  SCREENING_INTERESTS,
  SCREENING_INTEREST_KEYS,
  UPLOAD_LINK_MINUTES,
  LANDING_LINK_HOURS,
  SUPPLIER_GENDERS,
  SUPPLIER_GENDER_KEYS,
  SUPPLIER_LINK_DAYS,
  SUPPLIER_FILES,
  SUPPLIER_FILE_KEYS,
  SUPPLIER_FIELDS,
  SUPPLIER_FIELD_KEYS,
  SUPPLIER_PAYMENT_TERMS,
  SUPPLIER_STATUSES,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_REVIEW_STATES,
  HOSTEL_KINDS,
  HOSTEL_KIND_KEYS,
  HOSTEL_CONTACT_ROLES,
  HOSTEL_CONTACT_ROLE_KEYS,
  PERSON_DOCUMENT_KINDS,
  PERSON_DOCUMENT_KIND_KEYS,
  INVOICE_ROUND_PROGRAMS,
  INVOICE_ROUND_PROGRAM_LABELS,
  INVOICE_LINK_DAYS,
  INVOICE_SESSION_STATES,
  INVOICE_REQUEST_STATUSES,
  INVOICE_REQUEST_STATUS_LABELS,
  DIARY_KINDS,
  INVOICE_DUE_DAY,
  ABSENCE_REASONS,
  ABSENCE_REASON_KEYS,
  HOSTEL_REPORT_LINK_DAYS,
  HOSTEL_REPORT_SESSION_STATES,
  HOSTEL_REPORT_MARKS,
  HOSTEL_REPORT_STATUSES,
  HOSTEL_REPORT_STATUS_LABELS,
  ACTIVITY_KINDS,
  ACTIVITY_KIND_KEYS,
  ACTIVITY_FIELD_TYPES,
  DEFAULT_ACTIVITY_TEMPLATES,
  WAIVER_PARTIES,
  WAIVER_PARTY_KEYS,
  LEAVE_REASONS,
  LEAVE_REASON_KEYS,
  INCIDENT_PRIMARY,
  INCIDENT_PRIMARY_KEYS,
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
  STAFF_KINDS,
  STAFF_KIND_KEYS,
  RESET_LINK_HOURS,
  DOMAIN_META,
};
