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
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '75', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Filename used for the bundled sample so it shows up in the library too.
// Anything dropped into UPLOAD_DIR ahead of time appears automatically.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

// Static app
app.use(express.static(STATIC_DIR, {
  index: 'index.html',
  setHeaders: (res, p) => {
    if (/\.html$/i.test(p)) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    } else if (/\.(jsx|css)$/i.test(p)) {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  },
}));

// SPA-style fallback: any unmatched GET serves index.html so share-link
// `#hash` URLs keep working regardless of path.
app.get('*', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// JSON-style error handler — keeps the API consistent on unexpected errors.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`mailer-viewer listening on :${PORT}`);
  console.log(`  upload dir: ${UPLOAD_DIR}`);
  console.log(`  admin key:  ${ADMIN_KEY ? 'required' : 'OPEN (no key set)'}`);
  console.log(`  max upload: ${MAX_UPLOAD_MB}MB`);
});
