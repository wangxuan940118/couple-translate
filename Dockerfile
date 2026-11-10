FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/container-health.cjs ./scripts/container-health.cjs

USER node
EXPOSE 3000
CMD ["node", "server.js"]
