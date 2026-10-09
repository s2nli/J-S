# CODEX STUDYS (Vibrant batches) — setup & security notes

## How it works now (one flow, one data source)
- **Batch list**: `batches.json` is the only source. Every batch has `_id`, `courseId` and `rootId`
  (root folder). Currently: batch `35` → rootId `3929`, batch `8` → rootId `13` (moved out of the old `ROOTS` map in vibrant.js).
- **Viewer**: `vibrant.js` (inside `index.html`) is the only course viewer: batch → folders → video / PDF.
  `batch.html` is now just a redirect so old links still work (`batch.html?id=35` → `/?batch=35`).
- **Course data**: the browser calls only `/api/vb` (Vercel function in `api/vb.js`). The function signs requests
  server-side, checks that `course_id` is listed in `batches.json`, verifies the upstream answer really is the expected JSON, and
  returns clean `items` / `streams` / `url` values. It never returns key material.
- **Deep links / refresh**: `/?batch=35&tab=notes&p=4001:Physics;4101:Mechanics` — folder path is kept in the URL, so refresh,
  share and browser Back/Forward all work.

## REQUIRED before the viewer works: set 4 environment variables
Vercel → Project → Settings → Environment Variables (Production **and** Preview), then redeploy:

| Name | What it is |
|---|---|
| `VB_API_BASE` | Base URL of the course API (no trailing slash) |
| `VB_CLIENT_KEY` | value for the `x-client-key` header |
| `VB_SIGN_KEY` | HMAC key for `x-signature` |
| `VB_JWT_KEY` | HMAC key for the Bearer JWT |

Until all four exist, `/api/vb` answers `503 not_configured` and the viewer shows
"The course service is not configured yet" with a Retry button. Local test: `vercel dev` with a `.env` (see `.env.example`; never commit it).

## Exposed secrets found in the original ZIP — rotate them
1. `vibrant.js` contained a client key, a request-signing key and a JWT key in plain text (public to every visitor).
2. `batch.html` contained an API auth header (`auth-key`) for a different host (`Api.bidweb.lol`).

These values are in your old ZIP, git history and any deployed copy, so treat them as compromised: **rotate them with whoever issued them**,
then put the new values only in the env vars above. If they were *not* issued to you for this app, don't use them — get credentials you are authorised to use.
The values were intentionally not copied into any new file.

## Adding / changing a batch
Edit `batches.json`: set `_id` and `courseId` to the course id, and `rootId` to its root folder id. A batch without `rootId`
shows a clear "no rootId" message instead of silently loading folder 0 (the old default).

## Not verified against the real API (needs you)
The sandbox had no network, so the real API was never called. Everything was tested against a mock that checks the signature the same way.
Please smoke-test on the deployed site: open each batch, one folder, one video, one PDF. HLS (`.m3u8`) playback also needs hls.js
from cdnjs, which couldn't load here; PDFs still open through the third-party viewer `pdfweb.classx.co.in` (unchanged from before).
