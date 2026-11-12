# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source=https://github.com/ezcalm-code/moss_bot
LABEL org.opencontainers.image.description="moss-bots：接入 Telegram 与飞书的聊天机器人"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENTRYPOINT ["node", "dist/index.js"]
