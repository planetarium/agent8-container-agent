FROM oven/bun:1.2.10 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.2.10-slim

# install zsh
RUN apt-get update && apt-get install -y zsh && apt-get clean

# copy .zshrc
COPY .zshrc /root/.zshrc

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/preview.ts ./

RUN bun install --production --frozen-lockfile

WORKDIR /workspace

EXPOSE 3000

ENTRYPOINT ["sh", "-c", "bun /app/preview.ts & bun /app/dist/index.js"]
