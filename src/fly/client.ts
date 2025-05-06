import { FlyConfig, Machine, CreateMachineOptions } from './types';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class FlyClient {
  private config: FlyConfig;

  constructor(config: FlyConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://api.machines.dev/v1'
    };
  }

  /**
   * Creates a Fly machine and records it in the database.
   * @param options - Machine creation options (must include user token)
   * @param token - User token to associate with the machine
   */
  async createMachine(options: CreateMachineOptions, token: string): Promise<Machine> {
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
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }

      const machine: Machine = await res.json();

      // Extract relevant fields for DB
      const dbRecord = {
        token,
        machine_id: machine.id,
        ipv6: machine.private_ip || '',
        deleted: false,
        created_at: new Date(machine.created_at || Date.now()),
      };
      await prisma.machine.create({ data: dbRecord });

      return machine;
    } catch (e: unknown) {
      console.error("Fly API error:", e instanceof Error ? e.message : e);
      throw e;
    }
  }

  /**
   * Soft deletes a machine by setting the deleted field to true in the database.
   */
  async destroyMachine(machineId: string): Promise<void> {
    try {
      await prisma.machine.updateMany({
        where: { machine_id: machineId },
        data: { deleted: true },
      });
    } catch (e: unknown) {
      console.error("DB error (soft delete):", e instanceof Error ? e.message : e);
      throw e;
    }
  }

  /**
   * Returns all non-deleted machines from the database.
   */
  async listMachines(): Promise<any[]> {
    return await prisma.machine.findMany({
      where: { deleted: false },
    });
  }

  /**
   * Returns a single machine by machine_id from the database (if not deleted).
   */
  async getMachine(machineId: string): Promise<any | null> {
    return await prisma.machine.findFirst({
      where: { machine_id: machineId, deleted: false },
    });
  }

  /**
   * Returns the ipv6 address for a given machine_id, or null if not found or deleted.
   */
  async getMachineIp(machineId: string): Promise<string | null> {
    const machine = await prisma.machine.findFirst({
      where: { machine_id: machineId, deleted: false },
      select: { ipv6: true }
    });
    return machine?.ipv6 ?? null;
  }

  async getImageRef(): Promise<string | undefined> {
    return this.config.imageRef;
  }
} 