#!/bin/sh
(mv /app/pnpm /pnpm && echo "PNPM cache copied to /pnpm") &

exec bun /app/dist/index.js
