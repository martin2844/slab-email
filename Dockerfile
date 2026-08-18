FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production
EXPOSE 6981

USER node
CMD ["node", "dist/index.js"]
