FROM node:22.23.2-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts
FROM dependencies AS service-build
COPY tsconfig.server.json ./
COPY packages packages
COPY services services
COPY scripts scripts
RUN npm run build:server && npm prune --omit=dev --ignore-scripts
FROM node:22.23.2-bookworm-slim AS service
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=service-build --chown=node:node /app/node_modules ./node_modules
COPY --from=service-build --chown=node:node /app/dist/packages/domain/core.js ./dist/packages/domain/core.js
COPY --from=service-build --chown=node:node /app/dist/packages/contracts ./dist/packages/contracts
COPY --from=service-build --chown=node:node /app/dist/packages/providers ./dist/packages/providers
COPY --from=service-build --chown=node:node /app/dist/packages/runtime/crypto.js ./dist/packages/runtime/crypto.js
COPY --from=service-build --chown=node:node /app/dist/services/shared ./dist/services/shared
COPY --from=service-build --chown=node:node /app/dist/services/${SERVICE} ./dist/services/${SERVICE}
COPY --chown=node:node package.json ./
RUN printf 'import "./services/%s/main.js";\n' "$SERVICE" > dist/start.js
USER node
CMD ["node","dist/start.js"]
FROM dependencies AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
ARG GATEWAY_ORIGIN=http://gateway:4000
ENV GATEWAY_ORIGIN=$GATEWAY_ORIGIN
COPY apps/web apps/web
RUN npm run build:web
FROM node:22.23.2-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
CMD ["node","apps/web/server.js"]
