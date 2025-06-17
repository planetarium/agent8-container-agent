/// <reference types="node" />
/// <reference types="bun-types" />

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
  import { PrismaClient as BasePrismaClient } from '@prisma/client/runtime/library';

  export interface PrismaClient extends BasePrismaClient {
    machine_pool: {
      findMany: <T extends { select?: { machine_id: true } }>(args: {
        where?: { deleted?: boolean };
        select?: T['select'];
      }) => Promise<Array<T['select'] extends { machine_id: true } ? { machine_id: string } : never>>;
      updateMany: (args: {
        where: { machine_id: { in: string[] } };
        data: { deleted: boolean };
      }) => Promise<{ count: number }>;
      createMany: (args: {
        data: Array<{
          machine_id: string;
          ipv6: string;
          deleted: boolean;
          is_available: boolean;
          created_at: Date;
        }>;
        skipDuplicates?: boolean;
      }) => Promise<{ count: number }>;
      count: (args: {
        where: {
          is_available: boolean;
          deleted: boolean;
          assigned_to: null;
        };
      }) => Promise<number>;
    };
  }

  export interface machine_pool {
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

export {};