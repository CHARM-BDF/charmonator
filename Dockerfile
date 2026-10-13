# charmd (charmonator + charmonizer) container image.
#
# Build:   docker build -t charmd .
# Run:     docker run --rm -p 8080:8080 \
#            -v /path/to/config.json:/app/conf/config.json:ro charmd
#    or:   docker run --rm -p 8080:8080 -e CHARMONATOR_CONFIG_JSON="$(cat config.json)" charmd
#
# No configuration or credentials are baked in. Provide the config either as a
# mounted /app/conf/config.json or as CHARMONATOR_CONFIG_JSON; AWS credentials come
# from the ECS task role (default credential chain). Probes: GET /healthz, GET /readyz.
# Environment variables: docs/configuration.md › Environment variable override.

# Node.js 22 LTS, Debian bookworm slim, pinned by multi-arch index digest.
# Node 22, not 24: pdf-parse's bundled pdf.js 1.10 misreads pooled Buffers, which
# Node 24.18+ makes far more common; lib/pdf-parse-retry.mjs works around it, and
# the image stays on 22 as a second line of defence.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# pdf2pic needs GraphicsMagick + Ghostscript to rasterize PDF pages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends graphicsmagick ghostscript ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    CHARMONATOR_PORT=8080 \
    CHARMONATOR_CONFIG=/app/conf/config.json \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Tesseract English model, fetched at build time and verified, so OCR needs no
# internet at run time (tesseract.js reads ./eng.traineddata before downloading).
ARG TESSDATA_URL=https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz
ARG TESSDATA_SHA256=45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91
RUN node -e "\
  const crypto = require('crypto'), fs = require('fs'), zlib = require('zlib');\
  fetch(process.env.TESSDATA_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })\
  .then(ab => { const b = Buffer.from(ab);\
    const h = crypto.createHash('sha256').update(b).digest('hex');\
    if (h !== process.env.TESSDATA_SHA256) throw new Error('tessdata checksum mismatch: ' + h);\
    fs.writeFileSync('/app/eng.traineddata', zlib.gunzipSync(b)); })\
  .catch(e => { console.error(e); process.exit(1); });"

COPY server.mjs ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY static ./static
COPY tools ./tools
COPY mcp-servers ./mcp-servers
COPY conf ./conf

# Non-root runtime user; uploads/ is the only directory the app writes to.
RUN groupadd --system --gid 10001 charmd \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin charmd \
 && mkdir -p /app/uploads \
 && chown -R 10001:10001 /app/uploads
USER 10001:10001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CHARMONATOR_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
