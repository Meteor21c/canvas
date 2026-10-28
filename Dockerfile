# syntax=docker/dockerfile:1.7
# Meteor pilot: build the original React canvas only; no Go/SQLite service.
FROM oven/bun:1.3.14 AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION CHANGELOG.md /app/
COPY web ./
ARG SOURCE_REVISION
ENV SOURCE_REVISION=${SOURCE_REVISION}
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run typecheck && bun run test:pilot && bun run build

FROM node:22-alpine
WORKDIR /app
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/Meteor21c/canvas"
LABEL org.opencontainers.image.revision=${SOURCE_REVISION}
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=web-build --chown=node:node /app/web/public ./public
COPY --from=web-build --chown=node:node /app/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/web/.next/static ./.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=256
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/studio/pilot-health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
