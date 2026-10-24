# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @erp/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @erp/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @erp/api --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
# Writable directory for the local storage driver (mount a volume here, or use STORAGE_DRIVER=s3).
RUN mkdir -p /app/.data/uploads && chown -R node:node /app/.data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
