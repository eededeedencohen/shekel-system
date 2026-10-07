/**
 * @file Activity service - a person's record (לשונית פעילויות) and the
 *       templates the coordinators write from
 * @module services/activityService
 *
 * The social worker (2026-10-07): every event in a person's life with us
 * - intake, follow-up calls, evaluation calls, hospitalisations, general
 * updates, the closure report, the leave report, incidents - is one row
 * here, in order. Each kind has a template (title, opening text, small
 * fields); a world's stored template wins over the default in domain.js,
 * so a coordinator can change the questions without a deploy.
 *
 * Rules:
 *  - the person must exist in the world (and not be archived);
 *  - `fields` are validated against the template: unknown keys dropped,
 *    required ones present (unless the caller says `skipRequired` - the
 *    intake and the first call write their own fields), selects limited to
 *    their options, checkboxes booleans, dates real dates;
 *  - nothing here moves a pipeline; the follow-up clocks are derived by
 *    the client from the latest activity of each kind.
 */

const Activity = require("../models/Activity");
const ActivityTemplate = require("../models/ActivityTemplate");
const { Person } = require("../models/Person");
const AppError = require("../utils/AppError");
const {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_KEYS,
  ACTIVITY_FIELD_TYPES,
  DEFAULT_ACTIVITY_TEMPLATES,
  STUDENT_KINDS,
} = require("../utils/domain");

const clean = (s, max = 4000) => (s == null ? undefined : String(s).trim().slice(0, max) || undefined);
const kindLabel = (k) => ACTIVITY_KINDS.find((x) => x.key === k)?.label || k;

/* ───────────────────────── templates ───────────────────────── */

/** The default template of a kind (a copy). */
function defaultTemplate(kind) {
  const d = DEFAULT_ACTIVITY_TEMPLATES[kind] || { title: kindLabel(kind), body: "", fields: [] };
  return { kind, title: d.title || kindLabel(kind), body: d.body || "", fields: (d.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })), stored: false };
}

/** One template's public shape. */
function shapeTemplate(kind, doc) {
  if (!doc) return defaultTemplate(kind);
  const o = doc.toObject ? doc.toObject() : doc;
  return { kind, title: o.title || kindLabel(kind), body: o.body || "", fields: o.fields || [], stored: true, updatedBy: o.updatedBy, updatedAt: o.updatedAt };
}

/** Every kind's template for a world - the stored one where it exists, else the default. */
async function templatesOf(world) {
  const stored = await ActivityTemplate.find({ world }).lean();
  const byKind = new Map(stored.map((t) => [t.kind, t]));
  return ACTIVITY_KIND_KEYS.map((kind) => shapeTemplate(kind, byKind.get(kind)));
}

async function templateOf(world, kind) {
  if (!ACTIVITY_KIND_KEYS.includes(kind)) throw AppError.of("ACTIVITY_KIND_UNKNOWN", 400, kind);
  return shapeTemplate(kind, await ActivityTemplate.findOne({ world, kind }));
}

/** A template's fields, checked: keys unique, labels present, types known, selects with options. */
function cleanFields(fields) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  const out = [];
  for (const f of fields) {
    const key = clean(f?.key, 40)?.replace(/[^\w-]/g, "");
    const label = clean(f?.label, 80);
    if (!key || !label) throw AppError.of("TEMPLATE_INVALID", 400, "שדה בלי מפתח או שם");
    if (seen.has(key)) throw AppError.of("TEMPLATE_INVALID", 400, `מפתח כפול: ${key}`);
    seen.add(key);
    const type = ACTIVITY_FIELD_TYPES.includes(f?.type) ? f.type : "text";
    const options = type === "select" ? [...new Set((Array.isArray(f?.options) ? f.options : []).map((o) => clean(o, 60)).filter(Boolean))] : [];
    if (type === "select" && !options.length) throw AppError.of("TEMPLATE_INVALID", 400, `לשדה "${label}" אין אפשרויות`);
    out.push({ key, label, type, options, required: !!f?.required });
  }
  return out;
}

/** Store a world's template for a kind (replaces the default from here on). */
async function saveTemplate({ world, kind, title, body, fields, by }) {
  if (!ACTIVITY_KIND_KEYS.includes(kind)) throw AppError.of("ACTIVITY_KIND_UNKNOWN", 400, kind);
  const doc = await ActivityTemplate.findOneAndUpdate(
    { world, kind },
    { $set: { title: clean(title, 80) || kindLabel(kind), body: clean(body, 8000) || "", fields: cleanFields(fields), updatedBy: by } },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return shapeTemplate(kind, doc);
}

/** Back to the default (the stored one is deleted). */
async function resetTemplate({ world, kind }) {
  if (!ACTIVITY_KIND_KEYS.includes(kind)) throw AppError.of("ACTIVITY_KIND_UNKNOWN", 400, kind);
  await ActivityTemplate.deleteOne({ world, kind });
  return defaultTemplate(kind);
}

/* ───────────────────────── activities ───────────────────────── */

/** The small fields of an activity, checked against the template. */
function validateFields(template, raw, { skipRequired = false } = {}) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const f of template.fields || []) {
    let v = src[f.key];
    if (f.type === "checkbox") v = v === true || v === "true" || v === "on";
    else if (f.type === "date") {
      if (v === undefined || v === null || v === "") v = undefined;
      else {
        const d = new Date(v);
        if (isNaN(d.getTime())) throw AppError.of("INVALID_DATE", 400, f.label);
        v = d;
      }
    } else if (f.type === "select") {
      v = clean(v, 200);
      if (v && !(f.options || []).includes(v)) throw AppError.of("ACTIVITY_FIELD_REQUIRED", 400, `"${f.label}": ${v}`);
    } else v = clean(v, f.type === "textarea" ? 8000 : 400);
    if (f.required && !skipRequired && (v === undefined || v === "" || v === false)) throw AppError.of("ACTIVITY_FIELD_REQUIRED", 400, f.label);
    if (v !== undefined) out[f.key] = v;
  }
  // keys the template does not know are kept too (the first call, the leave report write their own)
  for (const [k, v] of Object.entries(src)) {
    if (!(k in out) && !(template.fields || []).some((f) => f.key === k) && v !== undefined && v !== null && v !== "") out[k] = typeof v === "string" ? clean(v, 400) : v;
  }
  return out;
}

/** The person, in this world, not archived. */
async function requirePerson(personId, world) {
  const person = await Person.findById(personId).select("world deletedAt firstName lastName");
  if (!person) throw AppError.of("NOT_FOUND", 404, "אדם");
  if (person.world !== world) throw AppError.of("WORLD_MISMATCH", 400);
  if (person.deletedAt) throw AppError.of("PERSON_DELETED", 400);
  return person;
}

/**
 * One new row. `fields` are validated against the kind's template of the
 * world; `skipRequired` lets a step that writes its own fields (the
 * intake, the first call, the leave report) skip the template's rules.
 */
async function addActivity({ world, person, kind, at, by, title, body, fields, program, related, skipRequired = false }) {
  if (!ACTIVITY_KIND_KEYS.includes(kind)) throw AppError.of("ACTIVITY_KIND_UNKNOWN", 400, kind);
  await requirePerson(person, world);
  const when = at ? new Date(at) : new Date();
  if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
  const template = await templateOf(world, kind);
  const row = await Activity.create({
    world,
    person,
    kind,
    at: when,
    by,
    title: clean(title, 120) || template.title,
    body: clean(body, 8000) || "",
    fields: validateFields(template, fields, { skipRequired }),
    program: STUDENT_KINDS.includes(program) ? program : undefined,
    related: related || undefined,
  });
  return row;
}

/** Edit the text, the date or the fields of a row (who edited is stamped). */
async function updateActivity({ world, id, at, title, body, fields, by }) {
  const row = await Activity.findOne({ _id: id, world });
  if (!row) throw AppError.of("NOT_FOUND", 404, "פעילות");
  if (at !== undefined) {
    const when = new Date(at);
    if (isNaN(when.getTime())) throw AppError.of("INVALID_DATE", 400);
    row.at = when;
  }
  if (title !== undefined) row.title = clean(title, 120) || row.title;
  if (body !== undefined) row.body = clean(body, 8000) || "";
  if (fields !== undefined) {
    const template = await templateOf(world, row.kind);
    row.fields = validateFields(template, fields, { skipRequired: true });
    row.markModified("fields");
  }
  row.editedAt = new Date();
  row.editedBy = by;
  await row.save();
  return row;
}

async function removeActivity({ world, id }) {
  const row = await Activity.findOne({ _id: id, world });
  if (!row) throw AppError.of("NOT_FOUND", 404, "פעילות");
  await row.deleteOne();
  return row;
}

/** The rows, newest first (of one person, or of the world). */
function listActivities({ world, person, kind, limit = 2000 }) {
  const filter = { world };
  if (person) filter.person = person;
  if (kind) filter.kind = kind;
  return Activity.find(filter).sort({ at: -1, createdAt: -1 }).limit(limit);
}

module.exports = {
  kindLabel,
  defaultTemplate,
  templatesOf,
  templateOf,
  saveTemplate,
  resetTemplate,
  validateFields,
  addActivity,
  updateActivity,
  removeActivity,
  listActivities,
};
