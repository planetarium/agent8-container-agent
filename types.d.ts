/// <reference types="node" />
/// <reference types="bun-types" />

import type { PrismaClient as BasePrismaClient } from '@prisma/client';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PORT?: string;
      WORKDIR_NAME?: string;
      COEP?: string;
      FORWARD_PREVIEW_ERRORS?: string;
      FLY_ROUTER_DOMAIN?: string;
      FLY_APP_NAME?: string;
      FLY_MACHINE_ID?: string;
      FLY_PROCESS_GROUP?: string;
      FLY_API_TOKEN?: string;
      TARGET_APP_NAME?: string;
      FLY_IMAGE_REF?: string;
      DEFAULT_POOL_SIZE?: string;
      CHECK_INTERVAL?: string;
      DATABASE_URL: string;
    }
  }
}

declare module '@prisma/client' {
  interface PrismaClient extends BasePrismaClient {
    $transaction<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T>;
  }

  interface machine_pool {
    id: bigint;
    created_at: Date;
    machine_id: string;
    deleted: boolean;
    ipv6: string | null;
    assigned_to: string | null;
    assigned_at: Date | null;
    is_available: boolean;
  }
}

declare module 'dotenv' {
  interface DotenvConfigOutput {
    parsed?: { [key: string]: string };
    error?: Error;
  }

  interface DotenvConfigOptions {
    path?: string;
    encoding?: string;
    debug?: boolean;
  }

  export function config(options?: DotenvConfigOptions): DotenvConfigOutput;
}