/* CODEX STUDYS in-app batch viewer: Lectures / Notes / About.
 *
 * Data flow (single source of truth):
 *   batches.json  ->  batch list (each batch carries courseId + rootId)
 *   /api/vb       ->  server-side signed proxy for folders / video streams / PDF links
 * No API keys or signing secrets live in this file (see api/vb.js and README-SETUP.md).
 *
 * Deep links:  /?batch=<courseId>[&tab=notes][&p=<folderId>:<title>;<folderId>:<title>]
 */
(function () {
  "use strict";
  const API = "/api/vb";
  const PDF_VIEWER = "https://pdfweb.classx.co.in/pdfjs/web/viewer-new.html";
  const PAGE = 20;
  const MAX_AUTO_PAGES = 10;
  const REQ_TIMEOUT = 20000;
  const HLS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js";
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const toast = (m) => (window.showToast || (() => {}))(m);

  /* ---------- API layer (talks only to our own /api/vb) ---------- */
  class ApiError extends Error { constructor(message, code) { super(message); this.code = code; } }

  async function api(params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
    let res;
    try {
      res = await fetch(API + "?" + new URLSearchParams(params), { headers: { Accept: "application/json" }, cache: "no-store", signal: ctrl.signal });
    } catch (e) {
      throw new ApiError(e && e.name === "AbortError" ? "The request timed out." : navigator.onLine === false ? "You appear to be offline." : "Could not reach the server.", "network");
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data) {
      if (!data && res.status === 404) throw new ApiError("The course API (/api/vb) is not deployed on this host.", "no_api");
      if (data && data.error === "not_configured") throw new ApiError("The course service is not configured yet (server environment variables are missing).", "not_configured");
      throw new ApiError((data && data.message) || `Request failed (${res.status}).`, (data && data.error) || "http");
    }
    return data;
  }

  async function listFolder(courseId, parentId, start) {
    const d = await api({ action: "folders", course_id: courseId, parent_id: parentId, start });
    return (d.items || []).filter((o) => o && typeof o === "object").map((o) => ({ ...o, title: o.Title || o.title || o.name || "Untitled" }));
  }
  async function getStreams(courseId, videoId) {
    const d = await api({ action: "play", course_id: courseId, video_id: videoId });
    if (!Array.isArray(d.streams) || !d.streams.length) throw new ApiError("No playable stream was returned for this lecture.", "no_stream");
    return d.streams;
  }
  async function getPdf(courseId, contentId) {
    const d = await api({ action: "pdf", course_id: courseId, content_id: contentId });
    if (!d.url) throw new ApiError("No PDF link was returned for this note.", "no_pdf");
    return d.url;
  }

  /* ---------- UI ---------- */
  const css = `
  #vbViewer{position:fixed;inset:0;z-index:9000;background:var(--bg,#080a0f);color:var(--text,#f4f6fb);overflow-y:auto;display:none;-webkit-overflow-scrolling:touch}
  #vbViewer.open{display:block}
  .vb-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--bg,#080a0f);border-bottom:1px solid var(--line,rgba(255,255,255,.09))}
  .vb-back{width:42px;height:42px;border-radius:12px;border:1px solid var(--line,rgba(255,255,255,.09));background:var(--panel-solid,#11151f);color:var(--brand-bright,#a69cff);display:grid;place-items:center;cursor:pointer;flex:none}
  .vb-top h2{margin:0;font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vb-wrap{max-width:760px;margin:0 auto;padding:16px}
  .vb-hero{border:1px solid var(--line,rgba(255,255,255,.09));border-radius:22px;overflow:hidden;background:var(--panel-solid,#11151f)}
  .vb-hero img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#1a1530}
  .vb-hero-body{padding:18px}
  .vb-hero h1{margin:0 0 6px;font-size:24px;line-height:1.2}
  .vb-hero p{margin:0 0 14px;color:var(--muted,#8d96a8)}
  .vb-pills{display:flex;gap:8px;flex-wrap:wrap}
  .vb-pill{padding:7px 14px;border-radius:999px;border:1px solid var(--line-strong,rgba(255,255,255,.16));font-size:13px;color:var(--muted-bright,#b4bdcd)}
  .vb-pill.acc{color:var(--brand-bright,#a69cff);border-color:rgba(139,124,255,.5);background:rgba(139,124,255,.1)}
  .vb-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
  .vb-tab{padding:15px 8px;border-radius:14px;border:1px solid var(--line,rgba(255,255,255,.09));background:transparent;color:var(--muted-bright,#b4bdcd);font:600 16px inherit;font-family:inherit;cursor:pointer}
  .vb-tab.active{background:linear-gradient(135deg,#8b7cff,#6c5ce7);color:#fff;border-color:transparent;box-shadow:0 10px 28px rgba(108,92,231,.35)}
  .vb-crumbs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 12px;font-size:13px;color:var(--muted,#8d96a8)}
  .vb-crumbs button{background:none;border:0;color:var(--brand-bright,#a69cff);cursor:pointer;font:inherit;padding:2px 0}
  .vb-list{display:flex;flex-direction:column;gap:12px}
  .vb-item{display:flex;align-items:center;gap:14px;padding:16px;border-radius:18px;border:1px solid var(--line,rgba(255,255,255,.09));background:var(--panel-solid,#11151f);cursor:pointer;text-align:left;color:inherit;font:inherit;width:100%}
  .vb-item:active{transform:scale(.99)}
  .vb-ico{width:46px;height:46px;border-radius:13px;background:rgba(139,124,255,.14);color:var(--brand-bright,#a69cff);display:grid;place-items:center;flex:none}
  .vb-ico svg{width:24px;height:24px}
  .vb-item .t{flex:1;min-width:0}
  .vb-item .t b{display:block;font-size:16px;line-height:1.3;word-break:break-word}
  .vb-item .t span{display:block;font-size:13px;color:var(--muted,#8d96a8);margin-top:3px}
  .vb-chev{color:var(--muted,#8d96a8);flex:none}
  .vb-msg{padding:28px 10px;text-align:center;color:var(--muted,#8d96a8)}
  .vb-more{margin:14px auto;display:block;padding:11px 22px;border-radius:12px;border:1px solid var(--line-strong,rgba(255,255,255,.16));background:transparent;color:inherit;cursor:pointer;font:inherit}
  .vb-about{padding:18px;border-radius:18px;border:1px solid var(--line,rgba(255,255,255,.09));background:var(--panel-solid,#11151f);line-height:1.6;color:var(--muted-bright,#b4bdcd)}
  .vb-about h3{margin:0 0 8px;color:var(--text,#f4f6fb)}
  .vb-skel{height:76px;border-radius:18px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.09),rgba(255,255,255,.04));background-size:200% 100%;animation:vbsk 1.2s infinite}
  @keyframes vbsk{to{background-position:-200% 0}}
  #vbPlayer{position:fixed;inset:0;z-index:9100;background:#000;display:none;flex-direction:column}
  #vbPlayer.open{display:flex}
  .vb-pbar{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0b0d13;color:#fff}
  .vb-pbar b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px}
  .vb-pbar select,.vb-pbar button{background:#161a24;color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 10px;font:inherit;font-size:13px}
  #vbPlayer video{flex:1;width:100%;min-height:0;background:#000}
  ` + `
  .vb-top{padding-top:max(14px,env(safe-area-inset-top))}
  .vb-pbar{padding-top:max(10px,env(safe-area-inset-top))}
  .vb-pbar select{max-width:28vw}
  #vbPlayer{height:100vh;height:100dvh}
  #vbNotice:empty{display:none}
  #vbNotice{margin:0 0 12px}
  .vb-note{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:14px;border:1px solid var(--line-strong,rgba(255,255,255,.16));background:var(--panel-solid,#11151f)}
  .vb-note.error{border-color:rgba(255,107,107,.55)}
  .vb-note>span{flex:1;min-width:150px;line-height:1.4}
  .vb-btn{padding:9px 16px;border-radius:10px;border:1px solid var(--line-strong,rgba(255,255,255,.16));background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
  .vb-btn.primary{background:linear-gradient(135deg,#8b7cff,#6c5ce7);border-color:transparent;color:#fff}
  .vb-spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.25);border-top-color:#a69cff;border-radius:50%;animation:vbspin .8s linear infinite;flex:none}
  @keyframes vbspin{to{transform:rotate(360deg)}}
  #vbPOverlay{position:absolute;left:0;right:0;top:56px;bottom:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;color:#fff;padding:20px;pointer-events:none}
  #vbPOverlay.show{display:flex}
  #vbPOverlay.err{background:rgba(0,0,0,.82);pointer-events:auto}
  #vbPOverlay .vb-btn{pointer-events:auto}
`;

  const ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg>';
  const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const ICON_PDF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
  const CHEV = '<svg class="vb-chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  let root, player, state = null, batches = [], pending = null, restored = false, opening = false;

  const courseIdOf = (b) => String(b.courseId ?? b._id ?? b.batch_id ?? "");
  const findBatch = (id) => batches.find((b) => courseIdOf(b) === String(id));
  const samePath = (a, b) => a.length === b.length && a.every((x, i) => String(x.id) === String(b[i].id));

  function ensureDom() {
    if (root) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "vbViewer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Batch content");
    root.innerHTML = `
      <div class="vb-top"><button class="vb-back" id="vbBack" aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg></button><h2 id="vbHeadTitle"></h2></div>
      <div class="vb-wrap">
        <div class="vb-hero"><img id="vbBanner" alt="" referrerpolicy="no-referrer"><div class="vb-hero-body"><h1 id="vbTitle"></h1><p id="vbSub"></p><div class="vb-pills" id="vbPills"></div></div></div>
        <div class="vb-tabs" id="vbTabs"><button class="vb-tab active" data-tab="lectures">Lectures</button><button class="vb-tab" data-tab="notes">Notes</button><button class="vb-tab" data-tab="about">About</button></div>
        <div id="vbNotice" aria-live="polite"></div>
        <div id="vbBody"></div>
      </div>`;
    document.body.appendChild(root);
    player = document.createElement("div");
    player.id = "vbPlayer";
    player.innerHTML = `<div class="vb-pbar"><button id="vbPClose" aria-label="Close player">✕</button><b id="vbPTitle"></b><select id="vbPQuality" aria-label="Quality"></select><select id="vbPSpeed" aria-label="Speed"><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select></div><video id="vbVideo" controls playsinline autoplay></video><div id="vbPOverlay" role="status"></div>`;
    document.body.appendChild(player);

    root.querySelector("#vbBack").addEventListener("click", closeBack);
    root.querySelector("#vbTabs").addEventListener("click", (e) => {
      const b = e.target.closest(".vb-tab");
      if (!b || !state || b.dataset.tab === state.tab) return;
      state.tab = b.dataset.tab;
      state.path = [];
      commit("push");
      render();
    });
    player.querySelector("#vbPClose").addEventListener("click", () => closePlayer());
    player.querySelector("#vbPQuality").addEventListener("change", (e) => playUrl(e.target.value, true));
    player.querySelector("#vbPSpeed").addEventListener("change", (e) => { document.getElementById("vbVideo").playbackRate = Number(e.target.value); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && player.classList.contains("open")) closePlayer(); });
    window.addEventListener("popstate", onPop);
  }

  /* ---------- URL state / history ---------- */
  function stateToUrl(s) {
    const p = new URLSearchParams(location.search);
    ["batch", "tab", "p"].forEach((k) => p.delete(k));
    if (s) {
      p.set("batch", s.id);
      if (s.tab !== "lectures") p.set("tab", s.tab);
      if (s.path.length) p.set("p", s.path.map((x) => x.id + ":" + encodeURIComponent(x.title)).join(";"));
    }
    const q = p.toString();
    return location.pathname + (q ? "?" + q : "") + location.hash;
  }

  function urlToState() {
    const p = new URLSearchParams(location.search);
    const id = p.get("batch");
    if (!id) return null;
    const t = p.get("tab");
    const path = (p.get("p") || "").split(";").filter(Boolean).map((seg) => {
      const i = seg.indexOf(":");
      if (i < 1) return null;
      let title = seg.slice(i + 1);
      try { title = decodeURIComponent(title); } catch (e) { /* keep raw */ }
      return { id: seg.slice(0, i), title };
    }).filter((x) => x && ID_RE.test(x.id));
    return { id, tab: ["lectures", "notes", "about"].includes(t) ? t : "lectures", path };
  }

  function depth() { return history.state && history.state.vb ? history.state.depth || 0 : 0; }

  function commit(mode) {
    const d = mode === "push" ? depth() + 1 : depth();
    try { history[mode === "push" ? "pushState" : "replaceState"]({ vb: 1, depth: d }, "", stateToUrl(state)); } catch (e) { /* e.g. file:// */ }
  }

  function onPop() {
    if (player.classList.contains("open")) stopPlayer();
    if (history.state && history.state.vb === 2) return; // a player entry: nothing to restore
    const t = urlToState();
    if (!t) { if (root.classList.contains("open")) hideViewer(); return; }
    applyState(t);
  }

  function makeState(batch, t) {
    return { batch, id: courseIdOf(batch), rootId: batch.rootId, tab: t.tab, path: t.path.slice(), seq: 0, items: [], start: 0, done: false };
  }

  function paintHeader(batch) {
    root.querySelector("#vbHeadTitle").textContent = batch.name || "Batch";
    root.querySelector("#vbTitle").textContent = batch.name || "Batch";
    root.querySelector("#vbSub").textContent = batch.byName || "Dedicated for Competitive Exams";
    root.querySelector("#vbPills").innerHTML = `<span class="vb-pill acc">Recorded</span><span class="vb-pill">${esc(batch.language || "Hinglish")}</span>`;
    const img = root.querySelector("#vbBanner");
    img.style.display = batch.previewImage ? "" : "none";
    img.onerror = () => { img.style.display = "none"; };
    img.src = batch.previewImage || "";
  }

  function showViewer(resetScroll) {
    root.classList.add("open");
    if (resetScroll) root.scrollTop = 0;
    document.documentElement.style.overflow = "hidden";
  }

  function hideViewer() {
    if (player && player.classList.contains("open")) stopPlayer();
    root.classList.remove("open");
    document.documentElement.style.overflow = "";
    state = null;
  }

  function applyState(t) {
    ensureDom();
    const batch = findBatch(t.id);
    if (!batch) {
      if (!batches.length) { pending = t; return; }
      return showMissing(t.id);
    }
    const open = root.classList.contains("open");
    if (open && state && state.id === courseIdOf(batch) && state.tab === t.tab && samePath(state.path, t.path)) return;
    const sameBatch = open && state && state.id === courseIdOf(batch);
    state = makeState(batch, t);
    if (!sameBatch) paintHeader(batch);
    showViewer(!sameBatch);
    render();
  }

  function showMissing(id) {
    state = null;
    root.querySelector("#vbHeadTitle").textContent = "Batch not found";
    root.querySelector("#vbTitle").textContent = "Batch not found";
    root.querySelector("#vbSub").textContent = "";
    root.querySelector("#vbPills").innerHTML = "";
    root.querySelector("#vbBanner").style.display = "none";
    root.querySelectorAll(".vb-tab").forEach((x) => x.classList.remove("active"));
    clearNotice();
    root.querySelector("#vbBody").innerHTML = `<div class="vb-msg" role="alert">No batch with id “${esc(id)}” exists in the course library.<br><br><button class="vb-btn primary" id="vbHome">Back to all batches</button></div>`;
    root.querySelector("#vbHome").addEventListener("click", () => { hideViewer(); try { history.replaceState(null, "", stateToUrl(null)); } catch (e) {} });
    showViewer(true);
  }

  /* Open from a batch card (user action). */
  function openViewer(batch) {
    ensureDom();
    state = makeState(batch, { tab: "lectures", path: [] });
    paintHeader(batch);
    showViewer(true);
    commit("push");
    render();
  }

  function closeBack() {
    if (!state) { hideViewer(); return; }
    if (history.state && history.state.vb === 1 && depth() > 0) { history.back(); return; }
    // Deep-linked entry: there is no in-app history to pop, so step up manually.
    if (state.path.length) { state.path.pop(); commit("replace"); render(); return; }
    hideViewer();
    try { history.replaceState(null, "", stateToUrl(null)); } catch (e) {}
  }

  /* ---------- Notices (loading / error with Retry) ---------- */
  function clearNotice() { const n = root && root.querySelector("#vbNotice"); if (n) n.innerHTML = ""; }
  function showNotice({ type, text, retry, link, linkText }) {
    const n = root.querySelector("#vbNotice");
    n.innerHTML = `<div class="vb-note ${type === "error" ? "error" : ""}" ${type === "error" ? 'role="alert"' : ""}>${type === "loading" ? '<i class="vb-spin"></i>' : ""}<span>${esc(text)}</span>${link ? `<a class="vb-btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(linkText || "Open")}</a>` : ""}${retry ? '<button class="vb-btn primary" data-act="retry">Retry</button>' : ""}${type !== "loading" ? '<button class="vb-btn" data-act="dismiss">Dismiss</button>' : ""}</div>`;
    const r = n.querySelector('[data-act="retry"]'); if (r) r.addEventListener("click", retry);
    const d = n.querySelector('[data-act="dismiss"]'); if (d) d.addEventListener("click", clearNotice);
  }

  /* ---------- Rendering ---------- */
  function render() {
    root.querySelectorAll(".vb-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
    clearNotice();
    const body = root.querySelector("#vbBody");
    if (state.tab === "about") {
      const b = state.batch;
      body.innerHTML = `<div class="vb-about"><h3>About this batch</h3>${esc(b.name || "")} — ${esc(b.byName || "recorded lectures and notes")}.<br>Language: ${esc(b.language || "Hinglish")}<br>Type: Recorded lectures + PDF notes. Open Lectures to watch videos and Notes for study material.</div>`;
      return;
    }
    if (state.rootId == null || state.rootId === "") {
      state.seq++;
      body.innerHTML = `<div class="vb-msg" role="alert">This batch has no <code>rootId</code> in batches.json, so its folders can't be listed. Add the root folder id for course ${esc(state.id)} and redeploy.</div>`;
      return;
    }
    loadFolder();
  }

  const kind = (it) => {
    const t = String(it.material_type || "").toUpperCase();
    if (t === "FOLDER") return "folder";
    if (t === "VIDEO") return "video";
    if (t === "PDF" || t === "STUDY_MATERIAL") return "pdf";
    return "other";
  };
  const itemKey = (c) => String(c.id ?? c.content_id ?? c.video_id ?? c.title);
  const wanted = (it) => { const k = kind(it); return k === "folder" || (state.tab === "notes" ? k === "pdf" : k === "video"); };

  function crumbs() {
    if (!state.path.length) return "";
    const parts = [`<button data-c="-1">${state.tab === "notes" ? "Notes" : "Lectures"}</button>`];
    state.path.forEach((p, i) => parts.push("›", `<button data-c="${i}">${esc(p.title)}</button>`));
    return `<nav class="vb-crumbs" aria-label="Folder path">${parts.join(" ")}</nav>`;
  }

  function bindCrumbs() {
    root.querySelectorAll(".vb-crumbs button").forEach((b) =>
      b.addEventListener("click", () => {
        const keep = Number(b.dataset.c) + 1;
        if (keep === state.path.length) return;
        state.path = state.path.slice(0, keep);
        commit("push");
        render();
      })
    );
  }

  async function loadFolder(more) {
    const body = root.querySelector("#vbBody");
    const mySeq = more ? state.seq : ++state.seq;
    const parentId = state.path.length ? state.path[state.path.length - 1].id : state.rootId;
    if (!more) {
      state.items = []; state.start = 0; state.done = false; state.moreError = "";
      body.innerHTML = crumbs() + '<div class="vb-list" aria-busy="true" aria-label="Loading"><div class="vb-skel"></div><div class="vb-skel"></div><div class="vb-skel"></div></div>';
      bindCrumbs();
    }
    try {
      let pages = 0;
      do {
        const chunk = await listFolder(state.id, parentId, state.start);
        if (mySeq !== state.seq) return;
        const known = new Set(state.items.map(itemKey));
        let added = 0;
        chunk.forEach((c) => { const k = itemKey(c); if (!known.has(k)) { known.add(k); state.items.push(c); added++; } });
        state.start += chunk.length || PAGE;
        state.done = chunk.length < PAGE || added === 0;
        pages++;
      } while (!state.done && !state.items.some(wanted) && pages < MAX_AUTO_PAGES);
      state.moreError = "";
      draw();
    } catch (err) {
      if (mySeq !== state.seq) return;
      if (more) { state.moreError = err.message || "Could not load more."; draw(); return; }
      body.innerHTML = crumbs() + `<div class="vb-msg" role="alert">Could not load this folder.<br><small>${esc(err.message || "")}</small><br><br><button class="vb-btn primary" id="vbRetry">Retry</button></div>`;
      bindCrumbs();
      body.querySelector("#vbRetry").addEventListener("click", () => loadFolder());
    }
  }

  function draw() {
    const body = root.querySelector("#vbBody");
    const items = state.items.filter(wanted);
    let html = crumbs();
    if (!items.length) {
      const other = state.items.some((it) => { const k = kind(it); return k === "video" || k === "pdf"; });
      const label = state.tab === "notes" ? "notes" : "lectures";
      const alt = state.tab === "notes" ? "lectures" : "notes";
      html += state.done
        ? `<div class="vb-msg">${state.items.length && other ? `No ${label} in this folder.<br><br><button class="vb-btn" id="vbAlt">Show ${alt} instead</button>` : state.items.length ? `No ${label} in this folder yet.` : "This folder is empty."}</div>`
        : '<div class="vb-msg">Loading…</div>';
    } else {
      html += '<div class="vb-list">' + items.map((it) => {
        const k = kind(it);
        const idx = state.items.indexOf(it);
        const sub = k === "folder" ? "Open" : k === "video" ? "Watch lecture" : "Open notes";
        return `<button class="vb-item" data-i="${idx}"><span class="vb-ico">${k === "folder" ? ICON_FOLDER : k === "video" ? ICON_VIDEO : ICON_PDF}</span><span class="t"><b>${esc(it.title)}</b><span>${sub}</span></span>${CHEV}</button>`;
      }).join("") + "</div>";
    }
    if (state.moreError) html += `<div class="vb-msg" role="alert"><small>${esc(state.moreError)}</small></div>`;
    if (!state.done) html += `<button class="vb-more" id="vbMore">${state.moreError ? "Retry" : "Load more"}</button>`;
    body.innerHTML = html;
    bindCrumbs();
    body.querySelectorAll(".vb-item").forEach((b) => b.addEventListener("click", () => openItem(state.items[Number(b.dataset.i)])));
    const more = body.querySelector("#vbMore");
    if (more) more.addEventListener("click", () => { more.textContent = "Loading…"; loadFolder(true); });
    const alt = body.querySelector("#vbAlt");
    if (alt) alt.addEventListener("click", () => { state.tab = state.tab === "notes" ? "lectures" : "notes"; commit("push"); render(); }); // stay in the same folder
  }

  /* ---------- Opening items ---------- */
  function openItem(it) {
    const k = kind(it);
    if (k === "folder") {
      if (it.id == null || !ID_RE.test(String(it.id))) return showNotice({ type: "error", text: "This folder has no valid id and can't be opened." });
      state.path.push({ id: String(it.id), title: it.title });
      commit("push");
      render();
      return;
    }
    if (opening) return;
    if (k === "video") playLecture(it);
    else if (k === "pdf") openNotes(it);
  }

  const friendly = (e, fallback) => (e && e.message) || fallback;

  async function playLecture(it) {
    const vid = it.video_id ? String(it.video_id) : String(it.id);
    opening = true;
    showNotice({ type: "loading", text: "Loading lecture…" });
    try {
      const streams = await getStreams(state.id, vid);
      clearNotice();
      openPlayer(it.title, streams);
    } catch (e) {
      showNotice({ type: "error", text: friendly(e, "Could not load this lecture."), retry: () => playLecture(it) });
    } finally { opening = false; }
  }

  async function openNotes(it) {
    // Open the tab synchronously inside the tap so mobile popup blockers allow it; sever opener before navigating away.
    let win = null;
    try { win = window.open("", "_blank"); if (win) { win.opener = null; win.document.title = "Opening notes…"; } } catch (e) { win = null; }
    opening = true;
    showNotice({ type: "loading", text: "Opening notes…" });
    try {
      const url = await getPdf(state.id, it.content_id ? String(it.content_id) : String(it.id));
      const target = `${PDF_VIEWER}?file=${encodeURIComponent(url)}&save_flag=1`;
      if (win && !win.closed) { win.location.href = target; clearNotice(); }
      else showNotice({ type: "ready", text: "Notes are ready.", link: target, linkText: "Open notes" });
    } catch (e) {
      try { if (win) win.close(); } catch (_) {}
      showNotice({ type: "error", text: friendly(e, "Could not open these notes."), retry: () => openNotes(it) });
    } finally { opening = false; }
  }

  /* ---------- Player ---------- */
  let hls = null, playToken = 0, currentUrl = "";
  function loadHls() {
    if (window.Hls) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = HLS_SRC;
      s.onload = res;
      s.onerror = () => { s.remove(); rej(new Error("hls.js failed to load")); };
      document.head.appendChild(s);
    });
  }

  function setOverlay(mode, text, retry) {
    const o = player.querySelector("#vbPOverlay");
    o.className = mode ? "show" + (mode === "error" ? " err" : "") : "";
    if (!mode) { o.innerHTML = ""; return; }
    o.innerHTML = (mode === "loading" ? '<i class="vb-spin"></i>' : "") + `<span>${esc(text)}</span>` + (mode === "error" ? `<div><button class="vb-btn primary" data-act="retry">Retry</button> <button class="vb-btn" data-act="close">Close</button></div>` : "");
    const r = o.querySelector('[data-act="retry"]'); if (r) r.addEventListener("click", retry);
    const c = o.querySelector('[data-act="close"]'); if (c) c.addEventListener("click", () => closePlayer());
  }

  function openPlayer(title, streams) {
    player.querySelector("#vbPTitle").textContent = title;
    const sel = player.querySelector("#vbPQuality");
    sel.innerHTML = streams.map((s) => `<option value="${esc(s.url)}">${esc(s.quality)}</option>`).join("");
    sel.style.display = streams.length > 1 ? "" : "none";
    player.classList.add("open");
    try { history.pushState({ vb: 2, depth: depth() + 1 }, "", location.href); } catch (e) {}
    playUrl(streams[0].url, false);
  }

  async function playUrl(url, keepTime) {
    const v = document.getElementById("vbVideo");
    const token = ++playToken;
    currentUrl = url;
    const t = keepTime ? v.currentTime : 0;
    if (hls) { hls.destroy(); hls = null; }
    const fail = (msg) => { if (token === playToken) setOverlay("error", msg, () => playUrl(url, true)); };
    const start = () => { if (token !== playToken) return; if (t) v.currentTime = t; v.playbackRate = Number(player.querySelector("#vbPSpeed").value); v.play().catch(() => {}); };
    setOverlay("loading", "Loading video…");
    v.onerror = () => fail("This video couldn't be played.");
    v.onplaying = v.onloadeddata = () => { if (token === playToken) setOverlay(null); };
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (v.canPlayType("application/vnd.apple.mpegurl")) { v.src = url; v.addEventListener("loadedmetadata", start, { once: true }); return; }
      try { await loadHls(); } catch (e) { return fail("The video player couldn't load. Check your connection."); }
      if (token !== playToken) return;
      if (!window.Hls.isSupported()) return fail("This browser can't play this stream.");
      hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) fail("Stream error (" + (d.details || d.type) + ")."); });
      hls.on(window.Hls.Events.MANIFEST_PARSED, start);
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      v.src = url;
      v.addEventListener("loadedmetadata", start, { once: true });
    }
  }

  /* Tear the player down without touching history (used by popstate). */
  function stopPlayer() {
    const v = document.getElementById("vbVideo");
    playToken++;
    v.onerror = v.onplaying = v.onloadeddata = null;
    v.pause();
    if (hls) { hls.destroy(); hls = null; }
    v.removeAttribute("src"); v.load();
    setOverlay(null);
    player.classList.remove("open");
  }

  function closePlayer() {
    const wasEntry = history.state && history.state.vb === 2;
    stopPlayer();
    if (wasEntry) history.back();
  }

  /* ---------- Public API ---------- */
  window.CXVibrant = {
    open: openViewer,
    /* app.js hands over the loaded batch list; a pending deep link is then resolved. */
    setBatches(list) {
      batches = Array.isArray(list) ? list : [];
      if (pending && batches.length) { const t = pending; pending = null; applyState(t); }
    },
    /* Open whatever the current URL points at (refresh / shared deep link). Runs once. */
    restoreFromUrl() {
      if (restored) return;
      restored = true;
      const t = urlToState();
      if (t) { ensureDom(); applyState(t); if (state) commit("replace"); }
    }
  };
})();
