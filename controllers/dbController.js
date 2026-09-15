/**
 * @file Database explorer controller
 * @module controllers/dbController
 *
 * Read-only introspection + raw browsing of every registered collection,
 * powering the in-app "בסיס הנתונים" page (see client pages/Database.jsx)
 * and kept in sync with the standalone schema doc (database-model.html).
 *
 * Three endpoints:
 *   GET /api/db/schema           — live Mongoose introspection: every
 *                                  collection's fields (types, refs, enums,
 *                                  flags, defaults), document counts and
 *                                  the full reference graph.
 *   GET /api/db/:collection      — raw documents, lean and WITHOUT populate
 *                                  (refs stay ObjectIds), with pagination,
 *                                  search, and a batched labels map so the
 *                                  client can render each ref as a readable
 *                                  link ("יוסי כהן" instead of a hex id).
 *   GET /api/db/:collection/:id  — one document + labels for every ref in
 *                                  it + every INCOMING reference: who, from
 *                                  which collection and path, points here.
 *
 * Deliberately ignores the X-Dataset demo scoping — this is the raw-truth
 * view, demo worlds included (each row's `dataset` tag is visible as-is).
 * Read-only by design: no write endpoint exists here.
 */

const mongoose = require("mongoose");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

// Explicit requires so every model is registered regardless of route load
// order. Profile discriminators (the user-type kinds) share the `profiles`
// collection — their extra paths are merged into the Profile entry below.
const { Person } = require("../models/Person");
const { Profile, MODEL_BY_KIND } = require("../models/profiles");
const MODELS = [
  Person,
  Profile,
  require("../models/Subject"),
  require("../models/Cycle"),
  require("../models/Enrollment"),
  require("../models/Lesson"),
  require("../models/Room"),
  require("../models/Hostel"),
  // תרבות לכל
  require("../models/Event"),
  require("../models/EventRegistration"),
  require("../models/Voucher"),
  // קליטה (אינטייק)
  require("../models/Intake"),
  // הספרייה
  require("../models/Book"),
  require("../models/Loan"),
];

/** Schemas that together describe one collection (discriminator merge). */
const SCHEMAS_OF = (M) =>
  M === Profile
    ? [Profile.schema, ...Object.values(MODEL_BY_KIND).map((k) => k.schema)]
    : [M.schema];

/** Discriminator refs resolve to the base model's collection. */
const MODEL_ALIAS = Object.fromEntries(Object.keys(MODEL_BY_KIND).map((k) => [k, "Profile"]));
const canonModel = (name) => MODEL_ALIAS[name] || name;

/** URL key (= Mongo collection name) → Model, e.g. "cycles". */
const BY_KEY = Object.fromEntries(MODELS.map((m) => [m.collection.name, m]));

/** Model name → URL key, e.g. "Cycle" → "cycles". */
const KEY_BY_MODEL = Object.fromEntries(
  MODELS.map((m) => [m.modelName, m.collection.name])
);

/** Mongoose options sometimes come as `[value, message]` — take the value. */
const bare = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Describe one SchemaType as a plain-JSON row. Arrays of subdocuments
 * recurse into `fields`; primitive arrays surface the element type as
 * "String[]" / "ObjectId[]" with the element's ref/enum lifted up.
 */
function describePath(path, st) {
  const o = st.options || {};
  const out = { path, type: st.instance || "Mixed" };

  if (st.instance === "ObjectId" && o.ref) out.ref = o.ref;

  const enumVals =
    st.enumValues && st.enumValues.length
      ? st.enumValues
      : Array.isArray(o.enum)
      ? o.enum
      : o.enum && o.enum.values;
  if (enumVals && enumVals.length) out.enum = enumVals;

  if (bare(o.required)) out.required = true;
  if (o.unique === true || (o.index && o.index.unique)) out.unique = true;
  if (o.index && o.index.sparse) out.sparse = true;
  if (o.index && !out.unique) out.indexed = true;
  if (o.default !== undefined && typeof o.default !== "function") {
    out.default = o.default;
  }
  if (o.min !== undefined) out.min = bare(o.min);
  if (o.max !== undefined) out.max = bare(o.max);

  if (st.instance === "Array") {
    if (st.schema) {
      // Array of subdocuments — recurse (skip each element's auto _id).
      out.type = "Subdocs[]";
      out.fields = [];
      st.schema.eachPath((p, sub) => {
        if (p === "_id" || p === "__v") return;
        out.fields.push(describePath(p, sub));
      });
    } else if (st.caster) {
      const el = describePath(path, st.caster);
      out.type = `${el.type}[]`;
      if (el.ref) out.ref = el.ref;
      if (el.enum) out.enum = el.enum;
    }
  }
  return out;
}

/**
 * All ref-bearing paths of a model, arrays flattened to dotted paths
 * ("enrolledStudents.student"). Computed once at module load.
 */
function refPathsOf(M) {
  const out = [];
  const seen = new Set();
  const push = (path, to) => {
    const key = `${path}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, to: canonModel(to) });
  };
  const walk = (schema, prefix) => {
    schema.eachPath((p, st) => {
      const full = prefix ? `${prefix}.${p}` : p;
      if (st.instance === "ObjectId" && st.options && st.options.ref) {
        push(full, st.options.ref);
      } else if (
        st.instance === "Array" &&
        st.caster &&
        st.caster.instance === "ObjectId" &&
        st.caster.options &&
        st.caster.options.ref
      ) {
        push(full, st.caster.options.ref);
      } else if (st.instance === "Array" && st.schema) {
        walk(st.schema, full);
      }
    });
  };
  for (const schema of SCHEMAS_OF(M)) walk(schema, "");
  return out;
}

/** modelName → [{path, to}] for every model. */
const REFS_BY_MODEL = Object.fromEntries(
  MODELS.map((m) => [m.modelName, refPathsOf(m)])
);

/** Every value at a dotted path, fanning out through arrays. */
function valuesAt(node, parts) {
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap((n) => valuesAt(n, parts));
  if (!parts.length) return [node];
  return valuesAt(node[parts[0]], parts.slice(1));
}

const asIdString = (v) => {
  if (v == null) return null;
  if (v instanceof mongoose.Types.ObjectId) return String(v);
  if (typeof v === "string" && mongoose.isValidObjectId(v)) return v;
  return null;
};

const personName = (u) =>
  u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || null : null;

/**
 * Human labels for documents of one model: id → label. Uses only cheap
 * batched queries; CourseInstance labels hop to the course name, and
 * Student/Teacher labels hop to their user's name.
 */
async function labelDocs(modelName, idStrings) {
  const out = {};
  if (!idStrings.length) return out;
  const ids = idStrings.map((s) => new mongoose.Types.ObjectId(s));
  const put = (id, label) => {
    if (label) out[String(id)] = label;
  };

  const name = canonModel(modelName);
  if (name === "Person") {
    const docs = await Person.find({ _id: { $in: ids } })
      .select("firstName lastName")
      .lean();
    docs.forEach((d) => put(d._id, personName(d)));
  } else if (name === "Profile") {
    const docs = await Profile.find({ _id: { $in: ids } }).select("person kind").lean();
    const personIds = [...new Set(docs.map((d) => asIdString(d.person)).filter(Boolean))];
    const names = await labelDocs("Person", personIds);
    docs.forEach((d) => {
      const who = names[asIdString(d.person)];
      put(d._id, who ? `${who} · ${d.kind}` : d.kind);
    });
  } else if (name === "Subject" || name === "Room" || name === "Hostel") {
    const docs = await mongoose
      .model(name)
      .find({ _id: { $in: ids } })
      .select("name")
      .lean();
    docs.forEach((d) => put(d._id, d.name));
  } else if (name === "Cycle") {
    const docs = await mongoose
      .model("Cycle")
      .find({ _id: { $in: ids } })
      .select("subject status")
      .populate("subject", "name")
      .lean();
    docs.forEach((d) => {
      const base = d.subject?.name || "מחזור";
      const extra = d.status && d.status !== "Active" ? ` · ${d.status}` : "";
      put(d._id, `${base}${extra}`);
    });
  } else if (name === "Enrollment") {
    const docs = await mongoose
      .model("Enrollment")
      .find({ _id: { $in: ids } })
      .select("student status")
      .lean();
    const studentIds = [
      ...new Set(docs.map((d) => asIdString(d.student)).filter(Boolean)),
    ];
    const names = await labelDocs("Person", studentIds);
    docs.forEach((d) => put(d._id, names[asIdString(d.student)]));
  } else if (name === "Lesson") {
    const docs = await mongoose
      .model("Lesson")
      .find({ _id: { $in: ids } })
      .select("date")
      .lean();
    docs.forEach((d) =>
      put(d._id, d.date ? new Date(d.date).toISOString().slice(0, 10) : null)
    );
  } else if (name === "Event") {
    const docs = await mongoose.model("Event").find({ _id: { $in: ids } }).select("name date").lean();
    docs.forEach((d) =>
      put(d._id, d.date ? `${d.name} · ${new Date(d.date).toISOString().slice(0, 10)}` : d.name)
    );
  } else if (name === "EventRegistration") {
    const docs = await mongoose
      .model("EventRegistration")
      .find({ _id: { $in: ids } })
      .select("student status")
      .lean();
    const studentIds = [...new Set(docs.map((d) => asIdString(d.student)).filter(Boolean))];
    const names = await labelDocs("Person", studentIds);
    docs.forEach((d) => put(d._id, names[asIdString(d.student)]));
  } else if (name === "Voucher") {
    const docs = await mongoose.model("Voucher").find({ _id: { $in: ids } }).select("name number").lean();
    docs.forEach((d) => put(d._id, `${d.name} #${d.number}`));
  }
  return out;
}

/**
 * Batched labels for every ref inside `docs` of model `M`, keyed
 * "collectionKey:idString" so the client resolves links in one lookup.
 */
async function resolveRefLabels(M, docs) {
  const byModel = {};
  for (const r of REFS_BY_MODEL[M.modelName]) {
    const parts = r.path.split(".");
    for (const d of docs) {
      for (const v of valuesAt(d, parts)) {
        const s = asIdString(v);
        if (s) (byModel[r.to] = byModel[r.to] || new Set()).add(s);
      }
    }
  }
  const labels = {};
  await Promise.all(
    Object.entries(byModel).map(async ([modelName, idSet]) => {
      const map = await labelDocs(modelName, [...idSet]);
      const key = KEY_BY_MODEL[modelName];
      for (const [id, label] of Object.entries(map)) {
        labels[`${key}:${id}`] = label;
      }
    })
  );
  return labels;
}

/** Search filter: ObjectId → match _id or any ref path; text → regex OR
 *  over every string path (incl. string arrays and subdoc strings). */
function buildFilter(M, q) {
  const s = (q || "").trim();
  if (!s) return {};

  if (mongoose.isValidObjectId(s)) {
    const id = new mongoose.Types.ObjectId(s);
    const or = [{ _id: id }];
    for (const r of REFS_BY_MODEL[M.modelName]) or.push({ [r.path]: id });
    return { $or: or };
  }

  const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const or = [];
  const seenPaths = new Set();
  const walk = (schema, prefix) => {
    schema.eachPath((p, st) => {
      if (p === "__v") return;
      const full = prefix ? `${prefix}.${p}` : p;
      if (seenPaths.has(full)) return;
      seenPaths.add(full);
      const isString =
        st.instance === "String" ||
        (st.instance === "Array" && st.caster && st.caster.instance === "String");
      if (isString) or.push({ [full]: rx });
      else if (st.instance === "Array" && st.schema) walk(st.schema, full);
    });
  };
  for (const schema of SCHEMAS_OF(M)) walk(schema, "");
  return or.length ? { $or: or } : { _id: null };
}

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

/** GET /api/db/schema */
exports.getDbSchema = catchAsync(async (req, res) => {
  const collections = await Promise.all(
    MODELS.map(async (M) => {
      const fields = [];
      const seenPaths = new Set();
      for (const schema of SCHEMAS_OF(M)) {
        schema.eachPath((p, st) => {
          if (p === "_id" || p === "__v" || seenPaths.has(p)) return;
          seenPaths.add(p);
          fields.push(describePath(p, st));
        });
      }
      let count = 0;
      try {
        count = await M.estimatedDocumentCount();
      } catch {
        /* DB not reachable — structure still renders */
      }
      return {
        key: M.collection.name,
        model: M.modelName,
        count,
        fields,
      };
    })
  );

  // The full reference graph, arrays flattened to dotted paths.
  const refs = [];
  for (const M of MODELS) {
    for (const r of REFS_BY_MODEL[M.modelName]) {
      refs.push({
        from: M.collection.name,
        path: r.path,
        to: KEY_BY_MODEL[r.to],
      });
    }
  }

  res.status(200).json({ status: "success", data: { collections, refs } });
});

/** GET /api/db/:collection */
exports.getDbCollection = catchAsync(async (req, res, next) => {
  const M = BY_KEY[req.params.collection];
  if (!M) {
    return next(new AppError(`אוסף לא מוכר: ${req.params.collection}`, 404));
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(
    LIMIT_MAX,
    Math.max(1, parseInt(req.query.limit, 10) || LIMIT_DEFAULT)
  );

  // Sort: a real schema path (optionally "-" prefixed) or the default
  // newest-first; anything unknown falls back silently.
  let sort = "-createdAt";
  const rawSort = (req.query.sort || "").trim();
  if (rawSort) {
    const field = rawSort.replace(/^-/, "");
    if (field === "_id" || M.schema.path(field)) sort = rawSort;
  }

  const filter = buildFilter(M, req.query.q);
  const [total, docs] = await Promise.all([
    M.countDocuments(filter),
    M.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);
  const labels = await resolveRefLabels(M, docs);

  res.status(200).json({
    status: "success",
    data: {
      docs,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      labels,
    },
  });
});

/** GET /api/db/:collection/:id */
exports.getDbRecord = catchAsync(async (req, res, next) => {
  const M = BY_KEY[req.params.collection];
  if (!M) {
    return next(new AppError(`אוסף לא מוכר: ${req.params.collection}`, 404));
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    return next(new AppError("מזהה רשומה לא חוקי", 400));
  }

  const doc = await M.findById(req.params.id).lean();
  if (!doc) return next(new AppError("הרשומה לא נמצאה", 404));

  const labels = await resolveRefLabels(M, [doc]);

  // Incoming references — who points at this record, from where.
  const incoming = [];
  for (const FM of MODELS) {
    for (const r of REFS_BY_MODEL[FM.modelName]) {
      if (r.to !== M.modelName) continue;
      const cond = { [r.path]: doc._id };
      const count = await FM.countDocuments(cond);
      if (!count) continue;
      const sample = await FM.find(cond).select("_id").limit(8).lean();
      const ids = sample.map((d) => String(d._id));
      const sampleLabels = await labelDocs(FM.modelName, ids);
      incoming.push({
        collection: FM.collection.name,
        model: FM.modelName,
        path: r.path,
        count,
        sample: ids.map((id) => ({ id, label: sampleLabels[id] || null })),
      });
    }
  }

  res.status(200).json({ status: "success", data: { doc, labels, incoming } });
});
