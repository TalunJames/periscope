# Deploying on TrueNAS Scale (behind your Cloudflare tunnel)

The app is a small Node + Express server that hosts the React/PDF.js
frontend, a PDF "library" at `/uploads/...`, and an upload API at
`/api/uploads`. The container listens on port 80; we publish it on a host
port (default `8080`) and your existing `cloudflared` tunnel forwards
your firm's subdomain at it.

Why a backend at all: share-links carry the *configuration* of a mailer
(fold, annotations, page assignments) in a `#hash`. To share the
*artwork* the recipient also needs to fetch the PDF from somewhere — and
that "somewhere" is your own domain, served by this container.

Storage lives in a named Docker volume (`mailer_uploads`) mounted at
`/data/uploads`, so PDFs survive container rebuilds.

---

## 1. Copy the project onto the NAS

```bash
ssh root@truenas
mkdir -p /mnt/<pool>/apps/mailer-viewer
# scp -r the repo into that folder, or git clone if you have it in git
```

The folder needs to contain at minimum:

- `Dockerfile`, `docker-compose.yml`
- `server.js`, `package.json`
- `Mailer Viewer.html`, `app.jsx`, `editor.jsx`, `viewer.jsx`, `styles.css`
- `uploads/` (the bundled sample PDF; gets seeded into the library on
  first boot)

## 2. Build & run

### Option A — TrueNAS Apps UI

1. Apps → **Discover Apps** → top-right kebab → **Install via YAML**.
2. Paste the contents of `docker-compose.yml`.
3. If you need a different host port, edit the `8080:80` line.
4. **Save** → wait for it to pull / build / start.

### Option B — CLI (most reliable)

```bash
cd /mnt/<pool>/apps/mailer-viewer
docker compose build
docker compose up -d
docker compose ps                  # should show "healthy" within ~10s
curl http://localhost:8080/healthz # → ok
curl http://localhost:8080/api/uploads
# → { "uploads": [ { "url": "/uploads/Listening...pdf", ... } ] }
```

## 3. Point your Cloudflare tunnel at it

In the Cloudflare Zero Trust dashboard → Networks → **Tunnels** → your
tunnel → **Public Hostnames** → **Add a public hostname**:

| Field    | Value                                |
| -------- | ------------------------------------ |
| Subdomain| e.g. `esign`                         |
| Domain   | your firm domain                     |
| Type     | `HTTP`                               |
| URL      | `<truenas-lan-ip>:8080`              |

(Use `HTTP`, not `HTTPS` — the container isn't terminating TLS;
Cloudflare handles that on the public side.)

Save. Within a few seconds `https://esign.yourfirm.com/` resolves.

## 4. Use the library

1. Visit `https://esign.yourfirm.com/` in admin mode.
2. Open **Configure** → **Mailer library**.
3. Click **+ Upload PDF to library** (or drag-drop a PDF anywhere on the
   page). The PDF saves to the `mailer_uploads` volume and becomes the
   active mailer.
4. Configure the fold / panels / annotations.
5. Click **Share link** in the admin bar.
6. Open the copied URL in an incognito window — it should load with
   the exact PDF + config you set up.

To host multiple mailers in parallel, repeat steps 2–5 with different
PDFs. Each share link points at a specific PDF via its `/uploads/...`
URL, so every link shows its own mailer.

## 5. (Optional) Locking down uploads

By default the upload endpoint is **open** — anyone who can reach the
domain can POST a PDF. That's intentional when the tunnel is gated by
Cloudflare Access or only exposed on your VPN.

If you ever want app-level protection, set the `ADMIN_KEY` env var in
`docker-compose.yml` to a long random string and `docker compose up -d`.
Then in the editor's **Mailer library** section paste the same value
into the **Admin token** field — it's stored in your browser's
localStorage and sent on every upload/delete. GET listing and the share
links themselves stay open either way.

```yaml
environment:
  ADMIN_KEY: "a-long-random-string-go-here"
```

## 6. Updating the app

Edit the source files on the NAS, then:

```bash
docker compose build --no-cache
docker compose up -d
```

Library PDFs persist across rebuilds (they live in the named volume).

To remove everything including PDFs:
```bash
docker compose down -v
```

## Troubleshooting

- **Cloudflare 502 / Bad Gateway** — the tunnel can't reach
  `<lan-ip>:8080`. From the TrueNAS shell: `curl http://localhost:8080/healthz`.
  If that works, the tunnel ingress URL is wrong (LAN IP changed, wrong port).
- **PDF doesn't render in the browser** — pdf.js loads its worker from
  unpkg.com. If your firm blocks egress, mirror
  `pdfjs-dist@2.16.105/build/pdf.worker.min.js` and update the
  `GlobalWorkerOptions.workerSrc` line near the top of `app.jsx`.
- **`Local preview only` warning** — that PDF is held in your browser
  only. Click **Save to library** to push it to the server so share
  links work.
- **Upload returns 413** — increase `MAX_UPLOAD_MB` in
  `docker-compose.yml` (default 75 MB) and restart.
- **Library is empty after a deploy** — the volume `mailer_uploads`
  may have been destroyed. Re-upload, or copy PDFs into
  `/var/lib/docker/volumes/mailer-viewer_mailer_uploads/_data/`
  manually.
