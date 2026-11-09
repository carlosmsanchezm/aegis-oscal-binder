# Multi-stage production image. No secrets are copied; env files stay out of the build context.
# Node 22 is the Active LTS line. Next.js standalone output is the server.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@10.33.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN npm install -g pnpm@10.33.3
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Keep the production build from creating or tracing a workspace data directory.
ENV AEGIS_DATA_DIR=/tmp/aegis-build-data
ARG AEGIS_COMMIT=
ENV AEGIS_COMMIT=${AEGIS_COMMIT}
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p /data && chown node:node /data
COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/fixtures ./fixtures
COPY --from=builder --chown=node:node /app/catalogs ./catalogs
USER node
ARG AEGIS_COMMIT=
ENV AEGIS_COMMIT=${AEGIS_COMMIT}
ENV AEGIS_DATA_DIR=/data
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
