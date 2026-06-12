# Intercom Matrix — read-only intercom matrix viewer + change-request platform.
#
# Node 25 is required: the request store uses the built-in `node:sqlite`
# (DatabaseSync), which is unflagged from Node 24 onward. poppler-utils
# provides `pdftotext`, used to parse config print PDFs server-side.
FROM node:25-slim

# pdftotext (poppler) for config-print PDF parsing. Without it, only
# pre-extracted -raw text uploads work (the app degrades gracefully).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    REQUESTS_DIR=/data

WORKDIR /app

# Install production deps first for layer caching (only express; sqlite is built in).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (public/, lib/, server.js) and the example config. The real
# systems.json (controller IPs) is mounted at runtime, never baked in.
COPY . .

# Request DB lives on a volume so it survives container replacement.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 8080

# Liveness: /api/systems responds 200 even with zero systems configured
# (unlike /api/status, which 404s when no system is selected).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/systems').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
