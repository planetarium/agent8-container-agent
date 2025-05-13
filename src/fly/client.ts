import { FlyConfig, Machine, CreateMachineOptions } from './types';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class FlyClient {
  private config: FlyConfig;
  private fallbackRegions: string[] = [];
  private RETRY_LIMIT = 3;

  constructor(config: FlyConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://api.machines.dev/v1'
    };
    this.updateFallbackRegions();
  }

  async updateFallbackRegions(): Promise<void> {
    if (!this.fallbackRegions.length) {
      const res = await fetch(`https://api.machines.dev/v1/platform/regions`);
      this.fallbackRegions = (await res.json() as { Regions: Record<string, unknown>[] }).Regions
        .filter((region) => !region.requires_paid_plan && (region.capacity as number) > 100)
        .map((region) => region.code as string);
    }
  }

  /**
   * Creates a Fly machine and records it in the database.
   * @param options - Machine creation options
   */
  async createMachine(options: CreateMachineOptions, retry: number = 0): Promise<Machine> {
    try {
      const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: options.name,
          region: options.region,
          config: {
            image: options.image,
            env: options.env,
            services: options.services,
            mounts: options.mounts,
            guest: options.resources,
          },
        }),
      });

      if (!res.ok) {
        if (retry < this.RETRY_LIMIT) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const randomIdx = Math.floor(Math.random() * this.fallbackRegions.length);
          return this.createMachine({ ...options, region: this.fallbackRegions[randomIdx] }, retry + 1);
        }
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }

      const machine: Machine = await res.json();

      // Extract relevant fields for DB
      const dbRecord = {
        machine_id: machine.id,
        ipv6: machine.private_ip || '',
        deleted: false,
        is_available: true,
        created_at: new Date(machine.created_at || Date.now()),
      };
      await prisma.machine_pool.create({ data: dbRecord });

      return machine;
    } catch (e: unknown) {
      console.error("Fly API error:", e instanceof Error ? e.message : e);
      throw e;
    }
  }

  /**
   * Destroys a machine by deleting it from the database and the Fly API.
   */
  async destroyMachine(machineId: string): Promise<void> {
    try {
      await prisma.machine_pool.updateMany({
        where: { machine_id: machineId },
        data: { deleted: true },
      });
    } catch (e: unknown) {
      console.error("DB error (soft delete):", e instanceof Error ? e.message : e);
      throw e;
    }

    const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}?force=true`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }
  }

  /**
   * Returns all non-deleted machines from the database.
   */
  async listMachines(): Promise<{
    machine_id: string;
    ipv6: string | null;
    deleted: boolean;
    assigned_to: string | null;
    assigned_at: Date | null;
    is_available: boolean;
    created_at: Date;
  }[]> {
    return await prisma.machine_pool.findMany({
      where: { deleted: false },
    });
  }

  /**
   * Returns a single machine by machine_id from the database (if not deleted).
   */
  async getMachine(machineId: string): Promise<{
    machine_id: string;
    ipv6: string | null;
    deleted: boolean;
    assigned_to: string | null;
    assigned_at: Date | null;
    is_available: boolean;
    created_at: Date;
  } | null> {
    return await prisma.machine_pool.findFirst({
      where: { machine_id: machineId, deleted: false },
    });
  }

  /**
   * Gets the IP address of a machine.
   * @param machineId - ID of the machine
   * @returns The machine's IP address or null if not found
   */
  async getMachineIp(machineId: string): Promise<string | null> {
    try {
      const machine = await prisma.machine_pool.findFirst({
        where: { machine_id: machineId },
        select: { ipv6: true }
      });
      return machine?.ipv6 || null;
    } catch (e: unknown) {
      console.error("Error getting machine IP:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  getImageRef(): string | undefined {
    return this.config.imageRef;
  }

  /**
   * Get real-time machine status from Fly API.
   * @param machineId - The ID of the machine to check
   * @returns Machine details and current status or null if not found
   */
  async getMachineStatus(machineId: string): Promise<Machine | null> {
    try {
      const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }
        console.error(`HTTP ${res.status} - ${res.statusText}`);
        return null;
      }

      return await res.json() as Machine;
    } catch (e: unknown) {
      console.error("Fly API error:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /**
   * Returns the list of actual machines from the Fly API (not the DB).
   */
  async listFlyMachines(): Promise<any[]> {
    try {
      const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }
      return await res.json();
    } catch (e: unknown) {
      console.error("Fly API error (listFlyMachines):", e instanceof Error ? e.message : e);
      return [];
    }
  }
}
