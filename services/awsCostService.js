/**
 * @file awsCostService - what Amazon charges the association, month by month
 * @module services/awsCostService
 *
 * Eden (2026-10-26): "מד לפי חודש כמה עולה לי השירותי של אמזון". The
 * numbers come from AWS Cost Explorer (GetCostAndUsage: the last six
 * months and the month so far, by service; GetCostForecast: where the
 * month is heading). Cost Explorer must be switched on in the account
 * once (Billing → Cost Explorer) and the app's IAM user needs
 * ce:GetCostAndUsage + ce:GetCostForecast; until then `available` is
 * false and the card says what to do. Every Cost Explorer call costs
 * $0.01 - so the answer is cached twelve hours, and AWS itself is about a
 * day behind, which the card says too.
 */

const AppError = require("../utils/AppError");

const TTL_MS = 12 * 60 * 60 * 1000;
const MONTHS_BACK = 6;
let cache = { at: 0, value: null };
let clientFactory = null; // tests inject a fake

function credentials() {
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

function makeClient() {
  if (clientFactory) return clientFactory();
  const creds = credentials();
  if (!creds) return null;
  // Cost Explorer lives in us-east-1 whatever the bucket's region
  const { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } = require("@aws-sdk/client-cost-explorer");
  const client = new CostExplorerClient({ region: "us-east-1", credentials: creds });
  return {
    costAndUsage: (input) => client.send(new GetCostAndUsageCommand(input)),
    forecast: (input) => client.send(new GetCostForecastCommand(input)),
  };
}

const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const iso = (d) => d.toISOString().slice(0, 10);
const firstOfMonth = (d, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
const round = (n) => Math.round(n * 100) / 100;

/** The Cost Explorer answer → months [{ month, total, byService }] (oldest first). */
function shapeMonths(res) {
  return (res?.ResultsByTime || []).map((r) => {
    const byService = {};
    let total = 0;
    for (const g of r.Groups || []) {
      const amount = Number(g.Metrics?.UnblendedCost?.Amount || 0);
      if (!amount) continue;
      byService[g.Keys?.[0] || "אחר"] = round(amount);
      total += amount;
    }
    if (!r.Groups?.length && r.Total?.UnblendedCost?.Amount) total = Number(r.Total.UnblendedCost.Amount);
    return { month: r.TimePeriod?.Start?.slice(0, 7), total: round(total), byService, estimated: !!r.Estimated };
  });
}

/** What the card renders: { available, reason?, currency, months, current, forecast, at, cachedUntil }. */
async function costs({ fresh = false, now = new Date() } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const client = makeClient();
  const base = { currency: "USD", at: new Date(), delayHours: 24 };
  if (!client) return { ...base, available: false, reason: "no-credentials" };
  const start = firstOfMonth(now, MONTHS_BACK - 1);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  let value;
  try {
    const usage = await client.costAndUsage({
      TimePeriod: { Start: iso(start), End: iso(tomorrow) },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    });
    const months = shapeMonths(usage);
    const thisMonth = ym(now);
    const current = months.find((m) => m.month === thisMonth) || { month: thisMonth, total: 0, byService: {}, estimated: true };
    let forecast = null;
    try {
      const endOfMonth = firstOfMonth(now, -1);
      if (endOfMonth.getTime() - tomorrow.getTime() > 24 * 3600 * 1000) {
        const f = await client.forecast({ TimePeriod: { Start: iso(tomorrow), End: iso(endOfMonth) }, Metric: "UNBLENDED_COST", Granularity: "MONTHLY" });
        const rest = Number(f?.Total?.Amount || 0);
        forecast = { total: round(current.total + rest), rest: round(rest) };
      } else forecast = { total: current.total, rest: 0 };
    } catch {
      forecast = null; // a brand-new account has no history to forecast from
    }
    value = { ...base, available: true, months, current, forecast };
  } catch (e) {
    const code = e?.name || e?.Code || "";
    const reason = /AccessDenied|UnrecognizedClient|InvalidClientTokenId|not authorized/i.test(code + (e?.message || "")) ? "no-permission" : /DataUnavailable|not enabled|has not been enabled/i.test(e?.message || "") ? "not-enabled" : "error";
    value = { ...base, available: false, reason, message: String(e?.message || "").slice(0, 200) };
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Tests: a fake client; `null` restores the real one and empties the cache. */
function _setClientFactory(f) {
  clientFactory = f;
  cache = { at: 0, value: null };
}

module.exports = { costs, shapeMonths, _setClientFactory, TTL_MS, AppError };
