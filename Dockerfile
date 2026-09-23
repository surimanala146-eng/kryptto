# ── build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_PATH=data/kryptto.db

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server/public ./public

EXPOSE 8080
# node:sqlite prints an ExperimentalWarning on Node 22; silence it.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
