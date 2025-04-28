FROM oven/bun:1.2.10 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.2.10-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

RUN bun install --production --frozen-lockfile

WORKDIR /workspace

EXPOSE 3000

ENTRYPOINT ["bun", "/app/dist/index.js"]
