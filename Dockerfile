# Mailer Viewer — single-process Node image.
# Serves the React/PDF.js app, /uploads/*.pdf, and the small upload API.
# Pair with any reverse proxy / Cloudflare Tunnel pointing at the
# published host port (default 8080).

FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=80 \
    UPLOAD_DIR=/data/uploads

WORKDIR /app

# Install deps first (cached layer).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Server entry.
COPY server.js ./

# Static app — every frontend file lives under /app/public so server.js
# can `express.static('public')` cleanly. The entry HTML has a space in
# its filename, so the JSON-array (exec) form of COPY is required.
RUN mkdir -p /app/public /app/seed-uploads /data/uploads
COPY app.jsx editor.jsx viewer.jsx homepage.jsx styles.css /app/public/
COPY blue-stacked.png white-stacked.png /app/public/
COPY ["Mailer Viewer.html", "/app/public/index.html"]

# The bundled sample PDF gets seeded into the upload volume on first run
# (so the library is never empty out-of-the-box). server.js copies any
# file from /app/seed-uploads into UPLOAD_DIR if it isn't already there.
COPY uploads/ /app/seed-uploads/

# Drop privileges. We use UID 568 (the "apps" user on TrueNAS Scale and
# the convention adopted by most NAS-friendly images) so bind-mounted
# datasets owned by apps:apps are writable out of the box. The node
# user that ships with the base image is removed in favor of an apps
# user at the right UID/GID. Override at runtime with `user: "X:Y"`
# in compose if your host uses a different UID convention.
RUN deluser --remove-home node \
 && addgroup -g 568 apps \
 && adduser -u 568 -G apps -S -H apps \
 && chown -R 568:568 /app /data
USER 568:568

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

EXPOSE 80

CMD ["node", "server.js"]
