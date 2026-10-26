/**
 * @file S3 storage driver - the files bucket behind presigned URLs
 * @module services/storage/s3Storage
 *
 * The server never carries a file's bytes (Eden, 2026-10-26: Render Starter
 * has 512MB and 100GB a month; the bucket is private). It only SIGNS:
 *   - a PUT the browser uploads with (5 minutes, the Content-Type and the
 *     `status=pending` tag are part of the signature, so the browser must
 *     send exactly those headers);
 *   - a GET the browser reads with (60 seconds, the file's own name in the
 *     Content-Disposition, inline or attachment);
 * and asks HEAD (exists? how big? what type?), clears the pending tag once
 * the file is attached to its record, and deletes.
 *
 * Env: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME
 * (project-files/specs/files-s3-plan.html, section 8). The IAM user may only
 * Put/Get/Delete/Tag objects of this one bucket - no listing.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, PutObjectTaggingCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const AppError = require("../../utils/AppError");

const PUT_SECONDS = 5 * 60;
const GET_SECONDS = 60;
const PENDING_TAG = "status=pending";

let client = null;
let bucket = null;

function configure() {
  if (client) return;
  const region = String(process.env.AWS_REGION || "").trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();
  bucket = String(process.env.AWS_S3_BUCKET_NAME || "").trim();
  if (!region || !accessKeyId || !secretAccessKey || !bucket) throw AppError.of("STORAGE_UNAVAILABLE", 503);
  client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

const inSeconds = (s) => new Date(Date.now() + s * 1000);
const disposition = (name, inline) => `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name || "file")}`;
/**
 * A HEAD / GET on a missing key: the SDK names it NotFound / NoSuchKey; and
 * because the app's IAM user may not list the bucket, S3 answers a missing
 * key with 403 rather than 404 - for this one bucket that too means "not there".
 */
const isMissing = (e) => e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404 || e?.$metadata?.httpStatusCode === 403;

/** A PUT the browser uploads with: { url, method, headers, expiresAt }. The headers MUST be sent as given. */
async function presignPut({ key, mime, pending = true }) {
  configure();
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mime, ...(pending && { Tagging: PENDING_TAG }) });
  const url = await getSignedUrl(client, cmd, { expiresIn: PUT_SECONDS, unhoistableHeaders: new Set(["x-amz-tagging"]) });
  return { url, method: "PUT", headers: { "Content-Type": mime, ...(pending && { "x-amz-tagging": PENDING_TAG }) }, expiresAt: inSeconds(PUT_SECONDS) };
}

/** A GET the browser reads with, for 60 seconds: { url, expiresAt }. */
async function presignGet({ key, mime, name, inline = true, expiresIn = GET_SECONDS }) {
  configure();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: mime || undefined,
    ResponseContentDisposition: disposition(name, inline),
    ResponseCacheControl: "private, max-age=60",
  });
  const url = await getSignedUrl(client, cmd, { expiresIn });
  return { url, expiresAt: inSeconds(expiresIn) };
}

/** { size, mime } of a stored object, or null when there is none. */
async function head(key) {
  configure();
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: r.ContentLength ?? 0, mime: String(r.ContentType || "").split(";")[0].trim() };
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

async function remove(key) {
  configure();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function removeMany(keys) {
  configure();
  const list = (keys || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
  }
}

/** The file is attached to its record: the pending tag goes, so the lifecycle rule leaves it alone. */
async function clearPending(key) {
  configure();
  await client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet: [] } }));
}

/** A server-side write (the migration script, a picture fetched from the web) - small files only. */
async function putBuffer({ key, body, mime, pending = false }) {
  configure();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mime, ...(pending && { Tagging: PENDING_TAG }) }));
}

/** The bytes of an object as a Buffer (the migration's verification; never a request path). */
async function getBuffer(key) {
  configure();
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

module.exports = { driver: "s3", PUT_SECONDS, GET_SECONDS, presignPut, presignGet, head, remove, removeMany, clearPending, putBuffer, getBuffer };
