/**
 * @file AuditEvent model - one write someone made through the API
 * @module models/AuditEvent
 *
 * Eden (2026-10-29): "עבור כל משתמש - איזה פעולות הוא עשה (לא דברים כמו
 * צפייה אלא דברים שגרמו לשינוי בבסיס נתונים כמו הוספה עריכה מחיקה)". The
 * audit middleware (utils/audit) writes one row for every POST / PUT /
 * PATCH / DELETE the API answered with success, once the answer left:
 *   - who: `account` is who is signed in, `actor` is who acted (the same,
 *     unless the super admin was viewing as someone - then the borrowed
 *     account), with their names as they were at the time;
 *   - what: the Hebrew `title` the describer gave the route ("שיבוץ לקורס",
 *     "מחיקת אירוע"), its `verb` (create / update / delete / other) and
 *     `kind` (course, person, event…), the `target` it touched (id + the
 *     name the answer carried) and a compact, secret-free `payload` of the
 *     request body;
 *   - where: method, path, the normalised `route`, the status, the ip.
 * Reads are never here, and nothing is ever deleted from it.
 */

const mongoose = require("mongoose");

const VERBS = ["create", "update", "delete", "other"];

const auditEventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    account: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount", required: true },
    accountName: { type: String, default: "" },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "StaffAccount", required: true },
    actorName: { type: String, default: "" },
    actorKind: { type: String, default: "" },
    session: { type: mongoose.Schema.Types.ObjectId, default: null },
    method: { type: String, required: true },
    /** The request path under /api, as asked ("/cycles/65f…"). */
    path: { type: String, required: true },
    /** The same with ids folded (":id") - the key the describer matched. */
    route: { type: String, required: true },
    status: { type: Number, required: true },
    verb: { type: String, enum: VERBS, required: true },
    title: { type: String, required: true },
    kind: { type: String, default: "" },
    target: {
      id: { type: String, default: null },
      label: { type: String, default: "" },
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: "" },
    ms: { type: Number, default: 0 },
  },
  { collection: "auditEvents", versionKey: false }
);

auditEventSchema.index({ at: -1 });
auditEventSchema.index({ account: 1, at: -1 });
auditEventSchema.index({ actor: 1, at: -1 });

module.exports = mongoose.model("AuditEvent", auditEventSchema);
module.exports.VERBS = VERBS;
