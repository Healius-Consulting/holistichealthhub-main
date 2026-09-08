FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY services/api-sql/package.json services/api-sql/package.json
COPY services/web/package.json services/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci
COPY services/api-sql services/api-sql
COPY packages/domain packages/domain
RUN npm run build --workspace @hhh/api-sql

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY services/api-sql/package.json services/api-sql/package.json
COPY services/web/package.json services/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci --omit=dev --workspace @hhh/api-sql && npm cache clean --force
COPY --from=build /workspace/services/api-sql/dist ./services/api-sql/dist
USER node
CMD ["node", "services/api-sql/dist/index.js"]
