FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Prisma selects its engine from the OpenSSL runtime available while generating.
# Keep builder and production on the same Debian/OpenSSL family.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# The backend image is built from the repository root so the immutable
# partition metadata can be copied without including firmware binaries.
# Install dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy source and prisma schema
COPY backend/ ./
COPY firmware/flash_layout.json ./firmware/flash_layout.json

# Generate Prisma client and build typescript
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node --from=builder /app/firmware/flash_layout.json ./firmware/flash_layout.json
RUN install -d -o node -g node /var/lib/farmos/firmware /var/lib/farmos/avatars

ENV NODE_ENV=production
ENV PORT=3000
ENV FARMOS_FLASH_LAYOUT_PATH=/app/firmware/flash_layout.json
ENV OTA_STORAGE_DIR=/var/lib/farmos/firmware
ENV AVATAR_STORAGE_DIR=/var/lib/farmos/avatars
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
