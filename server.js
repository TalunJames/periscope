// Mailer Viewer server.
// Serves the static React/PDF.js app, the PDF library at /uploads/*.pdf,
// and a small API for listing / uploading / deleting library PDFs.
//
// Env vars:
//   PORT         (default 80)     — listen port inside the container
//   UPLOAD_DIR   (default /data/uploads) — where library PDFs live
//   ADMIN_KEY    (default empty)  — if set, POST/DELETE /api/uploads
//                                   require `Authorization: Bearer <key>`.
//                                   Empty = open mode (deployed behind a
//                                   tunnel / Cloudflare Access in practice).
//   MAX_UPLOAD_MB (default 75)    — per-file size limit

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const compression = require('compression');

const PORT = parseInt(process.env.PORT || '80', 10);
const STATIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || '/data/uploads');
// Shares (short links): each is a JSON file `<id>.json` holding the saved
// viewer config. Defaults to a sibling dir of UPLOAD_DIR so it ends up on
// the same persistent volume.
const SHARES_DIR = path.resolve(
  process.env.SHARES_DIR || path.join(path.dirname(UPLOAD_DIR), 'shares')
);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '75', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_SHARE_BYTES = 256 * 1024; // generous: configs with many annotations

// Filename used for the bundled sample so it shows up in the library too.
// Anything dropped into UPLOAD_DIR ahead of time appears automatically.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SHARES_DIR, { recursive: true });

// Build identifier appended as a `?v=…` query string to every static asset
// referenced from index.html, so Cloudflare (and the browser) see a fresh
// URL on every deploy and never serve a stale CSS/JSX against a newer HTML.
// Sourced from env (BUILD_ID — set in CI / Dockerfile at build time) or
// falls back to the max mtime across all served assets, which catches any
// JSX/CSS/HTML edit in dev as well as fresh Docker image builds.
const BUILD_ID = (() => {
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID).slice(0, 16);
  try {
    const files = ['index.html', 'app.jsx', 'viewer.jsx', 'editor.jsx', 'homepage.jsx', 'styles.css'];
    let maxMtime = 0;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(STATIC_DIR, f));
        if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
      } catch {}
    }
    return Math.floor(maxMtime || Date.now()).toString(36);
  } catch {
    return Date.now().toString(36);
  }
})();

const SAMPLE_SRC = path.join(__dirname, 'seed-uploads');
if (fs.existsSync(SAMPLE_SRC)) {
  for (const f of fs.readdirSync(SAMPLE_SRC)) {
    const dst = path.join(UPLOAD_DIR, f);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(SAMPLE_SRC, f), dst);
    }
  }
}

// ---------- helpers ----------

function sanitizeBaseName(name) {
  const stripped = name.replace(/\.pdf$/i, '');
  const safe = stripped.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  return safe || 'mailer';
}

// Strip the `-<12hex>.pdf` suffix added at upload time so the library can
// show the original (sanitized) name to the user.
function prettyName(filename) {
  return filename
    .replace(/-[a-f0-9]{12}\.pdf$/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/_/g, ' ');
}

// Constant-time comparison guard against length-mismatch.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // open mode
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token && safeEqual(token, ADMIN_KEY)) return next();
  res.status(401).json({ error: 'Admin token required' });
}

// Refuse anything that isn't a sane PDF filename; prevents path traversal
// in DELETE /api/uploads/:filename.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+\.pdf$/;

// Share IDs are URL-safe base32-ish — short, no ambiguous chars.
const SAFE_SHARE_ID = /^[a-z0-9]{6,32}$/;
function makeShareId() {
  // 8 bytes → 16 hex chars; trim to 10 for shorter URLs while keeping
  // 40 bits of entropy (~1e12 IDs, ample for human-scale share volumes).
  return crypto.randomBytes(8).toString('hex').slice(0, 10);
}

// ---------- multer ----------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const base = sanitizeBaseName(file.originalname);
    const id = crypto.randomBytes(6).toString('hex');
    cb(null, `${base}-${id}.pdf`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf'
      || /\.pdf$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only PDF files are accepted'));
    cb(null, true);
  },
});

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(compression());
// JSON body parser scoped to /api/shares — keeps the existing /api/uploads
// (multipart) untouched.
app.use('/api/shares', express.json({ limit: MAX_SHARE_BYTES }));

// Health
app.get('/healthz', (req, res) => res.type('text/plain').send('ok\n'));

// Lets the frontend know whether the admin key gate is on, so it can
// show or hide the token input.
app.get('/api/auth-status', (req, res) => {
  res.json({ authRequired: !!ADMIN_KEY });
});

// List library
app.get('/api/uploads', async (req, res) => {
  try {
    const files = (await fsp.readdir(UPLOAD_DIR)).filter(f => /\.pdf$/i.test(f));
    const items = await Promise.all(files.map(async f => {
      const stat = await fsp.stat(path.join(UPLOAD_DIR, f));
      return {
        url: `/uploads/${encodeURIComponent(f)}`,
        filename: f,
        name: prettyName(f),
        size: stat.size,
        modified: stat.mtimeMs,
      };
    }));
    items.sort((a, b) => b.modified - a.modified);
    res.json({ uploads: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload one PDF. Field name: "pdf".
app.post('/api/uploads', requireAdmin, (req, res, next) => {
  upload.single('pdf')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
      url: `/uploads/${encodeURIComponent(req.file.filename)}`,
      filename: req.file.filename,
      name: prettyName(req.file.filename),
      size: req.file.size,
    });
  });
});

// Delete a library entry by exact filename (returned by the list endpoint).
app.delete('/api/uploads/:filename', requireAdmin, async (req, res) => {
  const filename = req.params.filename;
  if (!SAFE_FILENAME.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    await fsp.unlink(path.join(UPLOAD_DIR, filename));
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// ---------- shares ----------
// Create a share: stores the given viewer config under a random short id
// and returns the id + a relative URL. Auth-gated like uploads — only the
// admin should be minting share links.
app.post('/api/shares', requireAdmin, async (req, res) => {
  try {
    const config = req.body && req.body.config;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Missing config' });
    }
    // Strip any pdfDataUrl that snuck in — share recipients fetch from
    // pdfUrl or the bundled sample; data URLs would blow up the file.
    const slim = { ...config };
    delete slim.pdfDataUrl;
    const payload = JSON.stringify({
      created: Date.now(),
      config: slim,
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_SHARE_BYTES) {
      return res.status(413).json({ error: 'Share payload too large' });
    }
    // Try a few IDs in the unlikely event of collision.
    let id, full;
    for (let attempt = 0; attempt < 5; attempt++) {
      id = makeShareId();
      full = path.join(SHARES_DIR, `${id}.json`);
      try {
        await fsp.writeFile(full, payload, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        id = null;
      }
    }
    if (!id) return res.status(500).json({ error: 'Could not allocate share id' });
    res.json({ id, url: `/s/${id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch a share by id. Public (no auth) so recipients can load.
app.get('/api/shares/:id', async (req, res) => {
  const id = req.params.id;
  if (!SAFE_SHARE_ID.test(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const raw = await fsp.readFile(path.join(SHARES_DIR, `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Delete a share — admin only. Lets the operator revoke a link.
app.delete('/api/shares/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!SAFE_SHARE_ID.test(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await fsp.unlink(path.join(SHARES_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Serve PDFs from the library. We deliberately do NOT use express.static
// here so that filename traversal is impossible and so we can set the
// right Content-Type explicitly.
app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!SAFE_FILENAME.test(filename)) return res.sendStatus(400);
  const full = path.join(UPLOAD_DIR, filename);
  res.sendFile(full, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'public, max-age=86400',
    },
  }, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') res.sendStatus(404);
      else res.sendStatus(500);
    }
  });
});

// Read index.html once at startup and rewrite the script/stylesheet URLs
// to include a `?v=<BUILD_ID>` cache-buster. Cloudflare and browsers key
// their cache on the full URL, so every deploy gets a fresh cache entry —
// no more stale CSS against a new HTML.
const INDEX_HTML = (() => {
  try {
    const raw = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    return raw.replace(
      /(<(?:script|link)[^>]*\s(?:src|href)=")(\/(?:styles\.css|app\.jsx|viewer\.jsx|editor\.jsx|homepage\.jsx))(")/g,
      `$1$2?v=${BUILD_ID}$3`
    );
  } catch (e) {
    console.warn('Could not preload index.html:', e.message);
    return null;
  }
})();

// Static app — assets only. HTML and the SPA shell are handled below so
// we can serve the cache-busted version.
app.use(express.static(STATIC_DIR, {
  index: false,
  setHeaders: (res, p) => {
    if (/\.html$/i.test(p)) {
      // Should not be reached (HTML handled below), but guard anyway.
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    } else if (/\.(jsx|css)$/i.test(p)) {
      // The HTML always references these with ?v=<BUILD_ID>, so a long
      // immutable cache is safe — a new deploy uses a new query string.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(p)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// HTML routes — root and SPA-style fallback. Always serve the rewritten
// index.html with strong "do not cache" headers (Cloudflare honors these
// for HTML by default unless a Page Rule overrides).
function sendIndex(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (INDEX_HTML) {
    res.type('html').send(INDEX_HTML);
  } else {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  }
}
app.get('/', sendIndex);
// SPA-style fallback: any unmatched GET serves index.html so share-link
// URLs (and legacy `#c=…` hashes) keep working regardless of path.
app.get('*', sendIndex);

// JSON-style error handler — keeps the API consistent on unexpected errors.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`mailer-viewer listening on :${PORT}`);
  console.log(`  upload dir: ${UPLOAD_DIR}`);
  console.log(`  shares dir: ${SHARES_DIR}`);
  console.log(`  admin key:  ${ADMIN_KEY ? 'required' : 'OPEN (no key set)'}`);
  console.log(`  max upload: ${MAX_UPLOAD_MB}MB`);
});
