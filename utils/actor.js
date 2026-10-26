/**
 * @file actor - who is acting, from the session alone
 * @module utils/actor
 *
 * Stage 4 of the S3/hardening plan (Eden, 2026-10-26, section 9-א): every
 * "who did it" the server writes - `by`, `createdBy`, `movedBy`,
 * `uploadedBy`, the culture stamps - comes from here, never from the
 * request body. `req.actor` is the acting account (the signed-in one, or
 * the one a super admin views as - utils/auth); `person` is the optional
 * link from a staff account to its Person row (שירן, ייטב, שמרית), for
 * the records that expect a person id.
 *
 *   whoAmI(req) → { accountId, actorId, name, kind, personId, username }
 *   byOf(req)   → the name the record is signed with ("עדן כהן")
 */

function whoAmI(req) {
  const actor = req?.actor || req?.account || null;
  return {
    accountId: req?.account?._id || null,
    actorId: actor?._id || null,
    name: actor?.name || "",
    kind: actor?.kind || null,
    personId: actor?.person ? String(actor.person) : null,
    username: actor?.username || "",
  };
}

const byOf = (req) => whoAmI(req).name;

module.exports = { whoAmI, byOf };
