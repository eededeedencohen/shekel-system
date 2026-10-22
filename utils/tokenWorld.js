/**
 * @file The world of a public link comes from its token, not from the URL.
 * @module utils/tokenWorld
 *
 * Eden, 2026-10-21: "אין דבר כזה world בקישורים!!!" - a link handed to a
 * teacher, a house or a supplier is `/invoices/<token>`, nothing more. A
 * token is minted in one world and is unique, so the server can tell the
 * world from the token: this middleware looks the token up without a world
 * filter and sets `req.world` to the row's world, unless the request named
 * a world itself (the `X-Dataset` header, or `?world=` on a GET - the
 * staff's way of pointing a page at a demo world, kept for them).
 *
 *   router.use("/invoices/:token", tokenWorld([[InvoiceRequest, "token"]]));
 */

const explicitWorld = (req) => req.get("x-dataset") || (req.method === "GET" ? req.query.world : undefined);

/** `lookups`: [[Model, field], …] tried in order; the first row found decides. */
function tokenWorld(lookups) {
  return async (req, res, next) => {
    try {
      if (!explicitWorld(req) && req.params.token) {
        for (const [Model, field] of lookups) {
          const row = await Model.findOne({ [field]: req.params.token }).select("world").lean();
          if (row?.world) {
            req.world = row.world;
            break;
          }
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { tokenWorld };
