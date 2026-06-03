/* global React, ReactDOM, pdfjsLib, MailerViewer, MailerEditor, Homepage */
/* eslint-disable */

// =====================================================================
// App shell — state, PDF loading, persistence, drop-zone, editor sheet.
// =====================================================================

const { useState, useRef, useEffect, useCallback } = React;

const SAMPLE_PDF_URL = '/uploads/Listening_FSS_CSSD_Tier3_1_1c.pdf';
const STORAGE_KEY = 'mailerViewerConfig_v1';
const TOKEN_STORAGE_KEY = 'mailerAdminToken_v1';
const CLIENT_ACCESS_MSG =
  'That access code didn\u2019t work. Please contact your Fog Signal Strategies representative.';
const ACCESS_CODE_RE = /^[a-z0-9]{6,32}$/;
// Per-PDF title/description map: { [pdfUrl]: { title, description } }.
// Kept separate from the main config so switching PDFs restores the right
// human-friendly strings instead of carrying them across mailers.
const META_STORAGE_KEY = 'mailerMetaByUrl_v1';

function loadMetaMap() {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function saveMetaMap(m) {
  try { localStorage.setItem(META_STORAGE_KEY, JSON.stringify(m)); } catch {}
}

const DEFAULT_CONFIG = {
  // PDF sources, in priority order:
  //   pdfUrl       — server-hosted PDF (under /uploads/…). Lives in
  //                  share-links so recipients fetch it from your domain.
  //   pdfDataUrl   — local drag-drop preview. Stripped from share-links
  //                  because it's too big for a URL; recipients fall back
  //                  to the sample.
  //   neither      — use the bundled sample.
  pdfUrl: null,
  pdfDataUrl: null,
  pdfName: 'D11 Learning By Listening',
  // Admin-editable display strings shown to clients in the share view.
  // pdfName is derived from the filename; pdfTitle/pdfDescription are the
  // human-friendly overrides that travel with the share link.
  pdfTitle: '',
  pdfDescription: '',
  // Geometry
  foldType: 'cfold',         // cfold | zfold | half | gate | quarter
  numPanels: 3,              // 2 | 3 | 4
  orientation: 'vertical',   // vertical | horizontal
  // Paper dimensions in INCHES, in natural portrait (width <= height typical).
  // The "vertical" orientation displays portrait; "horizontal" rotates to landscape.
  pageWidth: 11,
  pageHeight: 17,
  // Custom crease positions along fold axis (0-1). null = equal divisions.
  // Length must be numPanels - 1 when set.
  creasePositions: null,
  // Page→side mapping
  outsidePageIdx: 0,
  insidePageIdx: 1,
  // Per-side print orientation:
  //   'normal' | 'rotate180' | 'flipH' | 'flipV'
  // Pre-applied to the source PDF page before slicing into panels.
  outsidePageOrient: 'normal',
  insidePageOrient: 'normal',
  // Per-side fine-tune: scale (1=natural), offsetX/Y (in panel widths/heights).
  outsideScale: 1, outsideOffsetX: 0, outsideOffsetY: 0,
  insideScale:  1, insideOffsetX:  0, insideOffsetY:  0,
  // Per-panel orient overrides. Each entry is
  // 'normal' | 'rotate180' | 'flipH' | 'flipV'. Lets the admin flip a
  // specific panel's content when its artwork was authored upside-down.
  // Separate arrays for outside and inside so e.g. an upside-down cover
  // can be corrected without flipping the inside content too.
  panelOrientsOutside: null,
  panelOrientsInside: null,
  // Legacy combined array. If present and the per-side arrays are null,
  // it's used as a fallback for both sides.
  panelOrients: null,
  // Tear-off
  tearPanel: 0,              // index of panel that tears off (0-based; null = no tear)
  // Perforations — line segments in NORMALIZED 0-1 coords on the OUTSIDE page
  perforations: [
    // Default: a horizontal perforation along the top edge of the bottom panel.
    // Will be visible as red dashed line on the editor preview.
    { x1: 0, y1: 2/3, x2: 1, y2: 2/3 },
  ],
  // Cosmetics
  showPerforation: true,
  showCreases: true,
  background: 'studio',
  // PDF.js render scale — higher = sharper artwork but slower load and more memory.
  // 1.0 ("HD") is a comfortable default for reading text at moderate zoom;
  // the app auto-bumps this further when the user zooms in.
  renderScale: 1.0,
  // Annotations placed on the mailer. Each: {id, panelIdx, x, y, content, isNeed}
  annotations: [],
  // Camera angle the viewer opens with. null = built-in front view.
  // Set via the "Mark as front" button after orbiting to the desired angle.
  defaultCamera: null,
};

// Decode a legacy (hash-based) shared config. Returns null if absent/invalid.
// Kept for backwards compatibility with links sent before short-link support
// was added; new links use /s/<id> via the server.
function decodeSharedConfig() {
  if (typeof location === 'undefined' || !location.hash) return null;
  const m = location.hash.match(/(?:^|[#&])c=([^&]+)/);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    return JSON.parse(atob(decoded));
  } catch (e) {
    console.warn('Bad share link hash:', e);
    return null;
  }
}

// Extract a short share id from the current URL.
// Supported forms:
//   /s/<id>      — preferred, clean path
//   /share/<id>  — friendlier alias
//   ?s=<id>      — query fallback (when proxies rewrite paths)
function extractShareId() {
  if (typeof location === 'undefined') return null;
  const p = location.pathname || '';
  let m = p.match(/^\/(?:s|share)\/([a-z0-9]{6,32})\/?$/i);
  if (m) return m[1].toLowerCase();
  m = (location.search || '').match(/[?&]s=([a-z0-9]{6,32})\b/i);
  if (m) return m[1].toLowerCase();
  return null;
}

// True when the URL is a share link (short path or legacy hash).
function isShareView() {
  return !!extractShareId() || !!decodeSharedConfig();
}

// True when the user has passed the homepage gate (/app).
function isAppPath() {
  if (typeof location === 'undefined') return false;
  return /^\/app\/?$/i.test(location.pathname || '');
}

// /s/… or /share/… present but id doesn't match the share-id format.
function isMalformedSharePath() {
  if (typeof location === 'undefined') return false;
  const p = location.pathname || '';
  if (!/^\/(?:s|share)\/.+/i.test(p)) return false;
  return !extractShareId();
}

function resolveView() {
  if (isMalformedSharePath()) return { mailer: false, accessError: true };
  if (isShareView() || isAppPath()) return { mailer: true, accessError: false };
  return { mailer: false, accessError: false };
}

function loadConfig() {
  // A legacy hash share-link still wins over localStorage so old links work.
  // Short-link configs are applied asynchronously after fetch (see App).
  const shared = decodeSharedConfig();
  if (shared) return { ...DEFAULT_CONFIG, ...shared, pdfDataUrl: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const stored = JSON.parse(raw);
    if (stored.flipInsidePage && !stored.insidePageOrient) {
      stored.insidePageOrient = 'flipV';
    }
    delete stored.flipInsidePage;
    return { ...DEFAULT_CONFIG, ...stored, pdfDataUrl: null };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Build a legacy hash-style share link. Used only as a fallback when the
// server's POST /api/shares is unreachable (e.g. static-only deploys).
function buildLegacyShareLink(config) {
  const { pdfDataUrl, ...slim } = config;
  const encoded = encodeURIComponent(btoa(JSON.stringify(slim)));
  const base = location.origin + location.pathname;
  return `${base}#c=${encoded}`;
}

function saveConfig(cfg) {
  try {
    const { pdfDataUrl, ...persisted } = cfg;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch (e) {
    console.warn('Config save failed:', e);
  }
}

// ---------------------------------------------------------------------
// Library client — wraps /api/uploads. Hides auth/header plumbing from
// the rest of the app and exposes a small async surface.
// ---------------------------------------------------------------------
function makeLibraryClient(getToken) {
  const authHeaders = () => {
    const t = getToken();
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  };
  return {
    async authStatus() {
      const res = await fetch('/api/auth-status');
      if (!res.ok) throw new Error('auth-status ' + res.status);
      return res.json(); // { authRequired }
    },
    async list() {
      const res = await fetch('/api/uploads');
      if (!res.ok) throw new Error('list ' + res.status);
      return res.json(); // { uploads: [...] }
    },
    async upload(file) {
      const fd = new FormData();
      fd.append('pdf', file);
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(msg.error || ('upload ' + res.status));
      }
      return res.json(); // { url, filename, name, size }
    },
    async remove(filename) {
      const res = await fetch(`/api/uploads/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(msg.error || ('delete ' + res.status));
      }
      return res.json();
    },
    async createShare(config) {
      const { pdfDataUrl, ...slim } = config; // never send the data URL
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ config: slim }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(msg.error || ('share ' + res.status));
      }
      return res.json(); // { id, url }
    },
    async fetchShare(id) {
      const res = await fetch(`/api/shares/${encodeURIComponent(id)}`);
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(msg.error || ('fetch share ' + res.status));
      }
      return res.json(); // { created, config }
    },
  };
}

// ---------------------------------------------------------------------
// PDF.js helper — render all pages of a PDF to off-screen canvases.
// Lower scale (0.6) for fast turnaround; the panel artwork is sliced &
// scaled up by CSS anyway.
// ---------------------------------------------------------------------
async function renderPdfToCanvases(src, scale = 0.6, isCancelled = () => false) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.worker.min.js';
  const loadingTask = pdfjsLib.getDocument(src);
  const doc = await loadingTask.promise;
  if (isCancelled()) { loadingTask.destroy?.(); throw new Error('cancelled'); }
  const canvases = [];
  let pdfWidthIn = null, pdfHeightIn = null;
  for (let p = 1; p <= doc.numPages; p++) {
    if (isCancelled()) { loadingTask.destroy?.(); throw new Error('cancelled'); }
    const page = await doc.getPage(p);
    const v = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = v.width;
    c.height = v.height;
    const renderTask = page.render({ canvasContext: c.getContext('2d'), viewport: v });
    await renderTask.promise;
    if (p === 1) {
      // PDF.js viewport at scale 1 returns dimensions in PDF user-space (1pt = 1/72 in).
      const v1 = page.getViewport({ scale: 1 });
      pdfWidthIn  = v1.width / 72;
      pdfHeightIn = v1.height / 72;
    }
    await new Promise(r => setTimeout(r, 0));
    canvases.push(c);
  }
  return { canvases, pdfWidthIn, pdfHeightIn };
}

// File → data URL (for storage)
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------
// Drop-zone overlay — listens at window level, shows full-screen target
// when a file is being dragged in.
// ---------------------------------------------------------------------
const DropZone = ({ onPdf }) => {
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  useEffect(() => {
    const onDragEnter = (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      counter.current += 1;
      setDragging(true);
      e.preventDefault();
    };
    const onDragOver = (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
    };
    const onDragLeave = (e) => {
      counter.current -= 1;
      if (counter.current <= 0) { counter.current = 0; setDragging(false); }
    };
    const onDrop = async (e) => {
      e.preventDefault();
      counter.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        alert('Please drop a PDF file.');
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      onPdf({ dataUrl, name: file.name.replace(/\.pdf$/i, ''), file });
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onPdf]);

  if (!dragging) return null;
  return (
    <div className="dropzone-overlay">
      <div className="dropzone-card">
        <div className="dropzone-icon">↓</div>
        <div className="dropzone-title">Drop PDF to preview</div>
        <div className="dropzone-sub">Replaces the current mailer</div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------
const LoadingOverlay = ({ status, error, name, clientFacing }) => {
  if (status === 'ready') return null;
  return (
    <div className="loading-overlay">
      {status === 'loading' && (
        <div>
          <div className="spinner" />
          Loading {name}…<br/>
          <small>Rendering PDF artwork</small>
        </div>
      )}
      {status === 'error' && (
        <div className={`err${clientFacing ? ' err-client' : ''}`}>
          {clientFacing ? CLIENT_ACCESS_MSG : (
            <>
              Couldn&apos;t load that PDF.<br/>
              <small>{error}</small>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------
// Mailer app — viewer, editor, PDF loading, library API.
// ---------------------------------------------------------------------
const MailerApp = () => {
  const [config, setConfig] = useState(loadConfig);
  const [pages, setPages] = useState(null);
  const [loadStatus, setLoadStatus] = useState('loading');
  const [loadErr, setLoadErr] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // Live user-zoom from the viewer. Drives dynamic PDF re-rendering at
  // higher resolution so text stays crisp when the user zooms in.
  const [viewerZoom, setViewerZoom] = useState(1);
  // Admin mode: true when in editing-capable mode. Hidden when client view.
  // Defaults to admin if no share link was supplied, otherwise starts in
  // client view so recipients see a clean preview.
  // Initial share id from the URL (set once, never re-read). Both a legacy
  // hash share and a short-link id flip us into client view.
  const initialShareId = useRef(extractShareId()).current;
  const [adminMode, setAdminMode] = useState(
    () => !decodeSharedConfig() && !initialShareId
  );
  // Tracks the PDF source we last completed a render for. Used so the
  // "adopt PDF intrinsic page dims" step fires only on a genuine source
  // change (upload/drop), not on every re-render (e.g., resolution change).
  const lastLoadedSourceRef = useRef(undefined);

  // ----- Library state (server-hosted PDFs) -----
  // serverAvailable: did /api/auth-status respond? Drives whether we
  //   try to upload drag-dropped PDFs or fall back to local preview.
  // authRequired:    does the server insist on a bearer token?
  // adminToken:      bearer token persisted in localStorage.
  // library:         current listing returned by /api/uploads.
  // libraryError:    last failure message (shown in the editor).
  const [serverAvailable, setServerAvailable] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminToken, setAdminTokenState] = useState(
    () => { try { return localStorage.getItem(TOKEN_STORAGE_KEY) || ''; } catch { return ''; } }
  );
  const [library, setLibrary] = useState([]);
  const [libraryError, setLibraryError] = useState(null);
  const adminTokenRef = useRef(adminToken);
  adminTokenRef.current = adminToken;
  const lib = useRef(makeLibraryClient(() => adminTokenRef.current)).current;

  const setAdminToken = useCallback((t) => {
    setAdminTokenState(t);
    try { localStorage.setItem(TOKEN_STORAGE_KEY, t || ''); } catch {}
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      const { uploads } = await lib.list();
      setLibrary(uploads || []);
      setLibraryError(null);
    } catch (e) {
      setLibraryError(e.message);
    }
  }, [lib]);

  // Probe the server on mount; if it responds, the library is in play.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await lib.authStatus();
        if (cancelled) return;
        setServerAvailable(true);
        setAuthRequired(!!s.authRequired);
        await refreshLibrary();
      } catch {
        if (!cancelled) setServerAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [lib, refreshLibrary]);

  // Upload a File to the library. On success, switches the active mailer
  // to the new entry (clears any local-only preview).
  const uploadFile = useCallback(async (file) => {
    const item = await lib.upload(file);
    await refreshLibrary();
    const saved = loadMetaMap()[item.url] || {};
    setConfig(c => ({
      ...c,
      pdfUrl: item.url,
      pdfDataUrl: null,
      pdfName: item.name,
      pdfTitle: saved.title || '',
      pdfDescription: saved.description || '',
      perforations: [],
    }));
    return item;
  }, [lib, refreshLibrary]);

  const selectFromLibrary = useCallback((item) => {
    if (!item || !item.url) return;
    const saved = loadMetaMap()[item.url] || {};
    setConfig(c => ({
      ...c,
      pdfUrl: item.url,
      pdfDataUrl: null,
      pdfName: item.name,
      pdfTitle: saved.title || '',
      pdfDescription: saved.description || '',
      perforations: [],
    }));
  }, []);

  const deleteFromLibrary = useCallback(async (filename) => {
    await lib.remove(filename);
    await refreshLibrary();
    // If the deleted PDF was the active one, fall back to the sample.
    setConfig(c => {
      if (!c.pdfUrl || !c.pdfUrl.endsWith('/' + filename)) return c;
      return { ...c, pdfUrl: null, pdfDataUrl: null, pdfName: 'Sample mailer' };
    });
  }, [lib, refreshLibrary]);

  const handleAddAnnotation = useCallback((ann) => {
    setConfig(c => ({ ...c, annotations: [...(c.annotations || []), ann] }));
  }, []);
  const handleUpdateAnnotation = useCallback((id, patch) => {
    setConfig(c => ({
      ...c,
      annotations: (c.annotations || []).map(a => a.id === id ? { ...a, ...patch } : a),
    }));
  }, []);
  const handleDeleteAnnotation = useCallback((id) => {
    setConfig(c => ({ ...c, annotations: (c.annotations || []).filter(a => a.id !== id) }));
  }, []);
  // Mint a share link. Tries the server first (short, persistent URL); on
  // failure falls back to the legacy hash form so the share button never
  // looks broken even if the server endpoint is down.
  const handleShareLink = useCallback(async () => {
    try {
      const { id, url } = await lib.createShare(config);
      const link = location.origin + url;
      console.log('[Share link]', link);
      return { link, kind: 'short', id };
    } catch (e) {
      console.warn('Short share failed, falling back to hash link:', e);
      const link = buildLegacyShareLink(config);
      return { link, kind: 'legacy', error: e.message };
    }
  }, [config, lib]);
  const handleSetDefaultCamera = useCallback((cam) => {
    setConfig(c => ({ ...c, defaultCamera: cam ? { x: cam.x, y: cam.y } : null }));
  }, []);

  // If the URL points at a short share (/s/<id>), fetch the stored config
  // and overlay it on top of defaults. Done once on mount.
  const [shareLoadState, setShareLoadState] = useState(
    () => (initialShareId ? 'pending' : 'n/a')
  );
  useEffect(() => {
    if (!initialShareId) return;
    let cancelled = false;
    (async () => {
      try {
        const { config: shared } = await lib.fetchShare(initialShareId);
        if (cancelled || !shared) return;
        setConfig(c => ({ ...DEFAULT_CONFIG, ...shared, pdfDataUrl: null }));
        setShareLoadState('ok');
      } catch (e) {
        if (!cancelled) setShareLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [initialShareId, lib]);

  // Save config whenever it changes — but don't persist while we're
  // displaying someone else's share (it would clobber the recipient's
  // own saved settings).
  useEffect(() => {
    if (initialShareId || decodeSharedConfig()) return;
    saveConfig(config);
  }, [config, initialShareId]);

  // Per-PDF meta (title + description) writer. Stored separately from the
  // main config so that switching mailers restores each one's own strings.
  // Recipients don't write (their pdfUrl belongs to the sender's library).
  useEffect(() => {
    if (initialShareId || decodeSharedConfig()) return;
    if (!config.pdfUrl) return;
    const map = loadMetaMap();
    const cur = map[config.pdfUrl] || {};
    const next = {
      title: config.pdfTitle || '',
      description: config.pdfDescription || '',
    };
    if (cur.title === next.title && cur.description === next.description) return;
    // Drop entries that are entirely empty so the map doesn't grow forever.
    if (!next.title && !next.description) {
      if (!(config.pdfUrl in map)) return;
      delete map[config.pdfUrl];
    } else {
      map[config.pdfUrl] = next;
    }
    saveMetaMap(map);
  }, [config.pdfUrl, config.pdfTitle, config.pdfDescription, initialShareId]);

  // Effective render scale = max of user setting and "what the current zoom
  // demands". Debounced so a quick scroll-wheel zoom doesn't kick off
  // multiple re-renders.
  const [effectiveRenderScale, setEffectiveRenderScale] = useState(
    () => Math.max(config.renderScale || 1.0, 1.0)
  );
  useEffect(() => {
    const base = Math.max(0.3, Math.min(3, config.renderScale || 1.0));
    // Each unit of CSS zoom needs ~1 unit of source-pixel density to stay
    // sharp. We cap at 2.5× since pdf.js memory/CPU climbs quickly past
    // that and panels rarely need more than printed-page detail.
    const need = Math.min(2.5, Math.max(base, viewerZoom * 0.95));
    // Quantize so we don't re-render for every tiny zoom change.
    const quantized = Math.round(need * 4) / 4;
    const id = setTimeout(() => setEffectiveRenderScale(quantized), 250);
    return () => clearTimeout(id);
  }, [config.renderScale, viewerZoom]);

  // Load PDF whenever pdfUrl / pdfDataUrl or render resolution changes
  useEffect(() => {
    if (shareLoadState === 'pending' || shareLoadState === 'error') return;
    let cancelled = false;
    // Priority: server URL → local data URL → bundled sample.
    const src = config.pdfUrl
      ? config.pdfUrl
      : config.pdfDataUrl
        ? convertDataUrl(config.pdfDataUrl)
        : SAMPLE_PDF_URL;
    const scale = effectiveRenderScale;
    // Identity of the PDF being loaded. Lets us distinguish a real source
    // change (upload/drop) from a re-render at a new resolution.
    const sourceId = config.pdfUrl || config.pdfDataUrl || '@sample';
    const wasFirstLoad = lastLoadedSourceRef.current === undefined;
    const sourceChanged = lastLoadedSourceRef.current !== sourceId;
    // Only show the full-screen loading overlay on a real source change.
    // Resolution-only re-renders happen quietly in the background so the
    // existing artwork stays visible while the higher-res pages load.
    if (sourceChanged) {
      setLoadStatus('loading');
      setLoadErr(null);
      setPages(null);
    }
    renderPdfToCanvases(src, scale, () => cancelled)
      .then(({ canvases, pdfWidthIn, pdfHeightIn }) => {
        if (cancelled) return;
        setPages(canvases);
        setLoadStatus('ready');
        lastLoadedSourceRef.current = sourceId;
        // Adopt PDF intrinsic dimensions as the page size only when the
        // source actually changed. Skipping this on re-renders prevents a
        // resolution change from clobbering a page size the user picked
        // in the editor.
        if (!sourceChanged || !pdfWidthIn || !pdfHeightIn) return;
        const w = Math.round(pdfWidthIn * 100) / 100;
        const h = Math.round(pdfHeightIn * 100) / 100;
        setConfig(c => {
          if (c.pageWidth === w && c.pageHeight === h) return c;
          // On the very first load, respect a share-link's custom dims —
          // assume the sender intended that page size.
          if (wasFirstLoad
              && (c.pageWidth !== DEFAULT_CONFIG.pageWidth
                  || c.pageHeight !== DEFAULT_CONFIG.pageHeight)) {
            return c;
          }
          return { ...c, pageWidth: w, pageHeight: h };
        });
      })
      .catch(e => {
        if (cancelled || e?.message === 'cancelled') return;
        console.error(e);
        setLoadErr(e.message || String(e));
        setLoadStatus('error');
      });
    return () => { cancelled = true; };
  }, [config.pdfUrl, config.pdfDataUrl, effectiveRenderScale, shareLoadState]);

  // Drag-drop handler. When the server is available we upload the file
  // straight into the library (so it's instantly sharable); otherwise we
  // fall back to a local-only preview via a data URL.
  const handleDroppedPdf = useCallback(async ({ dataUrl, name, file }) => {
    if (serverAvailable && file) {
      try {
        await uploadFile(file);
        return;
      } catch (e) {
        console.warn('Library upload failed, falling back to local preview:', e);
        setLibraryError(e.message);
      }
    }
    setConfig(c => ({
      ...c,
      pdfUrl: null,
      pdfDataUrl: dataUrl,
      pdfName: name,
      perforations: [],
    }));
  }, [serverAvailable, uploadFile]);

  const resetToSample = () => {
    setConfig({ ...DEFAULT_CONFIG });
  };

  // Client share view — hold on the error/loading screen, not the mailer UI.
  if (initialShareId && shareLoadState !== 'ok') {
    return (
      <LoadingOverlay
        status={shareLoadState === 'error' ? 'error' : 'loading'}
        error={null}
        name="preview"
        clientFacing
      />
    );
  }
  if (!adminMode && loadStatus === 'error') {
    return (
      <LoadingOverlay status="error" error={null} name="" clientFacing />
    );
  }

  return (
    <>
      <window.MailerViewer
        config={config}
        setConfig={setConfig}
        pages={pages}
        onOpenEditor={() => setEditorOpen(true)}
        adminMode={adminMode}
        onToggleAdmin={() => setAdminMode(v => !v)}
        onShareLink={handleShareLink}
        onSetDefaultCamera={handleSetDefaultCamera}
        onAddAnnotation={handleAddAnnotation}
        onUpdateAnnotation={handleUpdateAnnotation}
        onDeleteAnnotation={handleDeleteAnnotation}
        onZoomChange={setViewerZoom}
      />
      {adminMode && (
        <window.MailerEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          config={config}
          setConfig={setConfig}
          pages={pages}
          onResetSample={resetToSample}
          library={library}
          libraryError={libraryError}
          serverAvailable={serverAvailable}
          authRequired={authRequired}
          adminToken={adminToken}
          onSetAdminToken={setAdminToken}
          onUploadFile={uploadFile}
          onSelectFromLibrary={selectFromLibrary}
          onDeleteFromLibrary={deleteFromLibrary}
          onRefreshLibrary={refreshLibrary}
        />
      )}
      <DropZone onPdf={handleDroppedPdf} />
      <LoadingOverlay
        status={shareLoadState === 'error' ? 'error' : loadStatus}
        error={loadErr}
        name={config.pdfName}
        clientFacing={!adminMode}
      />
    </>
  );
};

// ---------------------------------------------------------------------
// App root — homepage at /, mailer at /app and share URLs.
// ---------------------------------------------------------------------
const App = () => {
  const [showMailer, setShowMailer] = useState(() => resolveView().mailer);
  const [accessError, setAccessError] = useState(() => resolveView().accessError);
  const [accessBusy, setAccessBusy] = useState(false);

  useEffect(() => {
    const sync = () => {
      const v = resolveView();
      setShowMailer(v.mailer);
      setAccessError(v.accessError);
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const enterMailer = useCallback(async (accessCode) => {
    const code = (accessCode || '').trim().toLowerCase();
    setAccessError(false);
    if (!code) return;
    if (!ACCESS_CODE_RE.test(code)) {
      setAccessError(true);
      return;
    }
    setAccessBusy(true);
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error();
      history.pushState(null, '', `/s/${code}`);
      setShowMailer(true);
    } catch {
      setAccessError(true);
    } finally {
      setAccessBusy(false);
    }
  }, []);

  if (!showMailer) {
    return (
      <Homepage
        onEnter={enterMailer}
        accessError={accessError}
        accessBusy={accessBusy}
        accessErrorMsg={CLIENT_ACCESS_MSG}
        onClearError={() => setAccessError(false)}
      />
    );
  }

  return <MailerApp />;
};

// data URL works directly with pdf.js; the helper here mostly exists to
// strip "data:application/pdf;base64," when we eventually need to pass
// a Uint8Array, but pdf.js accepts a string URL too.
function convertDataUrl(dataUrl) {
  if (dataUrl.startsWith('data:')) {
    const base64 = dataUrl.split(',')[1];
    const bin = atob(base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return { data: buf };
  }
  return dataUrl;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
