FROM oven/bun:1.2.10 AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy only necessary files for build
COPY prisma ./prisma
COPY src ./src
COPY index.ts tsconfig.json preview.ts ./

RUN bunx prisma generate && bun run build

FROM node:20-slim AS template-builder

WORKDIR /app

# Combine apt-get operations and clean up in one layer
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install npm and pnpm in one layer
RUN npm install -g npm@latest pnpm

# Clone and setup templates
RUN git clone --filter=blob:none --sparse https://github.com/planetarium/agent8-templates ./agent8-templates && \
    cd agent8-templates && \
    git sparse-checkout init --no-cone && \
    git sparse-checkout set */package.json

WORKDIR /app/agent8-templates
COPY merge-dependencies.js ./merge-dependencies.js
RUN node merge-dependencies.js

ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store

RUN pnpm install --frozen-lockfile || pnpm install

FROM oven/bun:1.2.10-slim

# Install all dependencies in one layer and clean up properly
RUN apt-get update && apt-get install -y \
    zsh \
    curl \
    python3 \
    make \
    g++ \
    build-essential \
    git \
    procps \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs openssl \
    && npm install -g npm@latest pnpm vite typescript ts-node \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# copy .zshrc
COPY .zshrc /root/.zshrc

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/preview.ts ./preview.ts
COPY --from=template-builder /pnpm /pnpm

# Copy and build pty-wrapper
COPY pty-wrapper /app/pty-wrapper
RUN cd /app/pty-wrapper && npm install && npm run build && rm -rf /root/.npm

RUN bun install --production --frozen-lockfile

# Set default environment variables
ENV PORT=3000 \
    WORKDIR_NAME=/home/project \
    COEP=credentialless \
    FORWARD_PREVIEW_ERRORS=true \
    NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store

WORKDIR /home/project

COPY --from=template-builder /app/agent8-templates /app/agent8-templates
COPY --from=template-builder /app/agent8-templates/node_modules ./node_modules

COPY .zshrc /home/agent8/.zshrc

# agent8 사용자 생성 및 권한 설정을 한 번에
RUN groupadd -r -g 2000 agent8 && \
    useradd -r -u 2000 -g agent8 -m agent8 && \
    chown -R agent8:agent8 /home/project && \
    chmod 777 /pnpm && \
    chown -R agent8:agent8 /pnpm && \
    chown -R agent8:agent8 /home/agent8 && \
    chmod 750 /proc

EXPOSE 3000

ENTRYPOINT ["bun", "/app/dist/index.js"]
