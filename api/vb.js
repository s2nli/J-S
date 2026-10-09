/**
 * Server-side course API proxy  ->  GET /api/vb?action=folders|play|pdf&...
 *
 * Why this exists: the course API requires signed requests. The signing keys used to be
 * hard-coded in vibrant.js (public, readable by anyone). They now live ONLY in environment
 * variables on the server; the browser never sees them.
 *
 * Required environment variables (names only - set the values in Vercel -> Settings -> Environment Variables):
 *   VB_API_BASE    base URL of the course API (no trailing slash)
 *   VB_CLIENT_KEY  value sent as the x-client-key header
 *   VB_SIGN_KEY    HMAC key for the x-signature header
 *   VB_JWT_KEY     HMAC key for the Bearer JWT
 *
 * Safety rules enforced here:
 *  - GET only, same-origin only (no CORS headers are ever sent)
 *  - course_id must be one of the batches listed in batches.json (it is NOT an open proxy)
 *  - ids are validated; only http(s) URLs are returned to the browser
 *  - upstream answers are verified to be JSON of the expected shape before being returned
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REQUIRED_ENV = ["VB_API_BASE", "VB_CLIENT_KEY", "VB_SIGN_KEY", "VB_JWT_KEY"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIMEOUT_MS = 12000;

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();

/* Same scheme the old browser code used, now computed on the server. */
function buildAuthHeaders(env, now = Date.now(), nonce = crypto.randomUUID()) {
  const ts = String(now);
  const signature = hmac(env.VB_SIGN_KEY, nonce + ts).toString("hex");
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now, exp: now + 30000 }));
  const sig = b64url(hmac(env.VB_JWT_KEY, head + "." + body));
  return {
    "x-client-key": env.VB_CLIENT_KEY,
    "x-nonce": nonce,
    "x-timestamp": ts,
    "x-signature": signature,
    Authorization: `Bearer ${head}.${body}.${sig}`,
    Accept: "application/json"
  };
}

function allowedCourseIds() {
  const file = path.join(process.cwd(), "batches.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(json) ? json : json.batches || [];
  return new Set(list.map((b) => String(b.courseId ?? b._id ?? b.id)));
}

const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u.trim());

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache || "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function sendUpstreamError(res, e) {
  const body = { error: e.code, message: e.message };
  if (e.upstreamStatus) body.upstreamStatus = e.upstreamStatus;
  send(res, e.status, body);
}

async function upstream(env, pathAndQuery) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(env.VB_API_BASE.replace(/\/+$/, "") + pathAndQuery, { headers: buildAuthHeaders(env), signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) return { error: { status: 502, code: "upstream_status", message: `Course API answered HTTP ${r.status}.`, upstreamStatus: r.status } };
    let json;
    try { json = JSON.parse(text); }
    catch (e) { return { error: { status: 502, code: "upstream_not_json", message: "Course API did not return JSON (HTTP 200 but unusable body)." } }; }
    if (json && typeof json === "object" && !Array.isArray(json) && (json.success === false || json.status === false || json.error)) {
      return { error: { status: 502, code: "upstream_error", message: String(json.message || json.error || "Course API reported an error.").slice(0, 200) } };
    }
    return { json };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { error: { status: timedOut ? 504 : 502, code: timedOut ? "upstream_timeout" : "upstream_unreachable", message: timedOut ? "Course API timed out." : "Course API could not be reached." } };
  } finally { clearTimeout(timer); }
}

function pickFolderItems(json) {
  const arr = Array.isArray(json) ? json : json && (json.items ?? json.data ?? json.children);
  return Array.isArray(arr) ? arr : null;
}

function pickStreams(d) {
  const out = [];
  if (d && Array.isArray(d.all)) d.all.forEach((o) => o && isHttpUrl(o.url) && out.push({ quality: String(o.quality || "Auto"), url: o.url.trim() }));
  else if (d && d.best && isHttpUrl(d.best.url)) out.push({ quality: String(d.best.quality || "Best"), url: d.best.url.trim() });
  else if (d && isHttpUrl(d.url)) out.push({ quality: "Default", url: d.url.trim() });
  return out;
}

async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed", message: "GET only." });

  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch (e) {}
    if (!ok) return send(res, 403, { error: "forbidden_origin", message: "Cross-origin requests are not allowed." });
  }

  const env = process.env;
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) return send(res, 503, { error: "not_configured", message: "The course service is not configured on the server.", missing });

  const q = new URL(req.url, "http://x").searchParams;
  const action = q.get("action");
  const courseId = q.get("course_id") || "";
  if (!ID_RE.test(courseId)) return send(res, 400, { error: "bad_request", message: "Invalid course_id." });
  let allowed;
  try { allowed = allowedCourseIds(); } catch (e) { return send(res, 500, { error: "batches_unreadable", message: "batches.json could not be read on the server." }); }
  if (!allowed.has(courseId)) return send(res, 404, { error: "unknown_course", message: "This course is not listed in batches.json." });

  const enc = encodeURIComponent;
  if (action === "folders") {
    const parent = q.get("parent_id") || "";
    const start = q.get("start") || "0";
    if (!ID_RE.test(parent) || !/^\d{1,6}$/.test(start)) return send(res, 400, { error: "bad_request", message: "Invalid parent_id or start." });
    const r = await upstream(env, `/api/folders?course_id=${enc(courseId)}&parent_id=${enc(parent)}&start=${enc(start)}`);
    if (r.error) return sendUpstreamError(res, r.error);
    const items = pickFolderItems(r.json);
    if (!items) return send(res, 502, { error: "upstream_shape", message: "Course API returned JSON, but not a folder listing." });
    return send(res, 200, { items }, "public, s-maxage=60, stale-while-revalidate=300");
  }
  if (action === "play") {
    const video = q.get("video_id") || "";
    if (!ID_RE.test(video)) return send(res, 400, { error: "bad_request", message: "Invalid video_id." });
    const r = await upstream(env, `/api/play?course_id=${enc(courseId)}&video_id=${enc(video)}`);
    if (r.error) return sendUpstreamError(res, r.error);
    const streams = pickStreams(r.json);
    if (!streams.length) return send(res, 404, { error: "no_stream", message: "No playable stream was returned for this lecture." });
    return send(res, 200, { streams });
  }
  if (action === "pdf") {
    const content = q.get("content_id") || "";
    if (!ID_RE.test(content)) return send(res, 400, { error: "bad_request", message: "Invalid content_id." });
    const r = await upstream(env, `/api/pdf?course_id=${enc(courseId)}&content_id=${enc(content)}`);
    if (r.error) return sendUpstreamError(res, r.error);
    const url = r.json && (r.json.url || r.json.pdf_url || r.json.link);
    if (!isHttpUrl(url)) return send(res, 404, { error: "no_pdf", message: "No PDF link was returned for this note." });
    return send(res, 200, { url: url.trim() });
  }
  return send(res, 400, { error: "bad_request", message: "Unknown action." });
}

module.exports = handler;
module.exports._internal = { buildAuthHeaders, pickStreams, pickFolderItems, REQUIRED_ENV };
