# syntax=docker/dockerfile:1
# Build context: repository root  ->  docker build -f apps/api/Dockerfile .

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build --workspace apps/api

FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --include-workspace-root --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY db/migrations ./db/migrations
# Never run as root inside the container.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Apply pending migrations (advisory-locked, so safe with several replicas), then start.
CMD ["sh", "-c", "node apps/api/dist/scripts/migrate.js && node apps/api/dist/index.js"]
