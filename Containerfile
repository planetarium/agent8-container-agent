FROM oven/bun:1.2.10 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.2.10-slim

# install zsh and build dependencies for node-pty
RUN apt-get update && apt-get install -y \
    zsh \
    curl \
    python3 \
    make \
    g++ \
    build-essential \
    && apt-get clean

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest && \
    npm install -g pnpm vite typescript ts-node && \
    apt-get clean

# copy .zshrc
COPY .zshrc /root/.zshrc

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Copy and build pty-wrapper
COPY pty-wrapper /app/pty-wrapper
RUN cd /app/pty-wrapper && npm install && npm run build

RUN bun install --production --frozen-lockfile

# Set default environment variables
ENV PORT=3000 \
    WORKDIR_NAME=/workspace \
    COEP=credentialless \
    FORWARD_PREVIEW_ERRORS=true \
    NODE_ENV=development

WORKDIR /workspace

COPY --from=builder /app/preview.ts ./

EXPOSE 3000

ENTRYPOINT ["bun", "/app/dist/index.js"]
