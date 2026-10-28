# syntax=docker/dockerfile:1.7
# Bun installs dependencies; the actual Node runtime compiles/runs Next.
FROM oven/bun:1.3.14 AS bun-bin
FROM node:22-bookworm-slim AS web-build
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION CHANGELOG.md /app/
COPY web ./
ARG SOURCE_REVISION
ENV SOURCE_REVISION=${SOURCE_REVISION}
ENV NEXT_TELEMETRY_DISABLED=1
RUN node --version && bun run typecheck && bun run test:meteor
RUN node ./node_modules/next/dist/bin/next build

FROM golang:1.27.3-alpine AS api-build
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg
WORKDIR /app
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/Meteor21c/canvas"
LABEL org.opencontainers.image.revision=${SOURCE_REVISION}
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY VERSION CHANGELOG.md ./
COPY --from=api-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=api-build --chown=node:node /server ./server
COPY --chown=node:node --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=web-build --chown=node:node /app/web/public ./web/public
COPY --from=web-build --chown=node:node /app/web/.next/standalone ./web
COPY --from=web-build --chown=node:node /app/web/.next/static ./web/.next/static
RUN mkdir -p /app/data/prompts /app/data/logs /app/data/storage && chown node:node /app/data /app/data/prompts /app/data/logs /app/data/storage
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=320 GOMEMLIMIT=224MiB GOMAXPROCS=2
ENV METEOR_MODE=true METEOR_API_BASE=http://sub2api:8080
ENV DATABASE_DSN=/app/data/infinite-canvas.db PROMPT_DATA_DIR=/app/data/prompts AI_LOG_DIR=/app/data/logs/ai-calls
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/studio/studio-health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/docker-entrypoint.sh"]
