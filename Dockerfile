# Shared base: install workspace dependencies once, reuse for every service.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate
WORKDIR /app

# Copy only the manifests first so dependency installation stays cached
# across source-code edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY artifacts/api-server/package.json  artifacts/api-server/
COPY artifacts/ascension/package.json   artifacts/ascension/
COPY lib/api-client-react/package.json  lib/api-client-react/
COPY lib/api-spec/package.json          lib/api-spec/
COPY lib/db/package.json                lib/db/
COPY scripts/package.json               scripts/

RUN pnpm install --frozen-lockfile

COPY . .

# ── Migration runner ─────────────────────────────────────────────────────────
# Pushes the Drizzle schema, then applies the hand-written SQL migrations.
# Runs to completion and exits; the api service waits for it.
FROM base AS migrate
CMD ["pnpm", "--filter", "@workspace/scripts", "run", "migrate"]

# ── Web (Vite dev server) ────────────────────────────────────────────────────
#
# Development only — `vite dev`, not a production build. Deliberately NOT the
# last stage: a `docker build` with no --target builds whichever stage comes
# last, and a host that offers no way to choose one (DigitalOcean App Platform,
# among others) would then deploy the dev server. It did, and the container
# crash-looped on a missing dist/index.mjs, because this stage never runs the
# build that produces it.
FROM base AS web
EXPOSE 5173
CMD ["pnpm", "--filter", "@workspace/ascension", "run", "dev"]

# ── API server ───────────────────────────────────────────────────────────────
#
# LAST ON PURPOSE. This is the production image, so it is what an untargeted
# build produces. Compose names every target explicitly, so moving this does
# not change local development.
FROM base AS api
RUN pnpm --filter @workspace/api-server run build
EXPOSE 8080
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
