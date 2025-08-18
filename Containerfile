FROM oven/bun:1.2.20 AS builder

WORKDIR /app

# Install openssl to fix Prisma version detection
RUN apt-get update && apt-get install -y openssl && apt-get clean

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN bunx prisma generate
RUN bun run build

FROM node:20-slim AS template-builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    git \
    && apt-get clean

RUN npm install -g npm@latest && \
    npm install -g pnpm

RUN git clone --filter=blob:none --sparse https://github.com/planetarium/agent8-templates ./agent8-templates && \
    cd agent8-templates && \
    git sparse-checkout init --no-cone && \
    git sparse-checkout set */package.json

WORKDIR /app/agent8-templates
COPY merge-dependencies.js ./merge-dependencies.js
RUN node merge-dependencies.js

ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store

RUN pnpm update

FROM oven/bun:1.2.20-slim

# install zsh and build dependencies for node-pty
RUN apt-get update && apt-get install -y \
    zsh \
    curl \
    python3 \
    make \
    g++ \
    build-essential \
    git \
    procps \
    && apt-get clean

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs openssl && \
    npm install -g npm@latest && \
    npm install -g pnpm vite typescript ts-node && \
    apt-get clean

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
RUN cd /app/pty-wrapper && npm install && npm run build

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

# agent8 사용자 생성
RUN groupadd -r -g 2000 agent8 && useradd -r -u 2000 -g agent8 -m agent8

# 작업 디렉토리 생성 및 권한 설정
RUN chown -R agent8:agent8 /home/project
RUN chmod 777 /pnpm
RUN chown -R agent8:agent8 /pnpm
RUN chown -R agent8:agent8 /home/agent8
# 다른 시스템 디렉토리 접근 제한
RUN chmod 750 /proc

EXPOSE 3000

ENTRYPOINT ["bun", "/app/dist/index.js"]
