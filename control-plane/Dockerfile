FROM docker.m.daocloud.io/library/node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM docker.m.daocloud.io/library/node:22-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/src ./dist/src
COPY sql ./sql

EXPOSE 3000

CMD ["node", "dist/src/server.js"]
