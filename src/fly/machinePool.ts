/// <reference types="node" />
/// <reference types="bun-types" />

import { FlyClient } from './client';
import { PrismaClient as BasePrismaClient, type machine_pool } from '@prisma/client';

const prisma = new BasePrismaClient();

interface FlyMachine {
  id: string;
  private_ip?: string;
  created_at?: string;
  state?: string;
  region?: string;
  instance_id?: string;
  version?: string;
  image_ref?: string;
  image?: string;
}

type MachinePoolRecord = machine_pool;
type TransactionCallback<T> = (tx: BasePrismaClient) => Promise<T>;

function isFlyMachine(obj: unknown): obj is FlyMachine {
  return typeof obj === 'object' && obj !== null && 'id' in obj;
}

export class MachinePoolManager {
  private readonly flyClient: FlyClient;
  private readonly defaultPoolSize: number;
  private readonly checkInterval: number;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    flyClient: FlyClient,
    options: {
      defaultPoolSize: number;
      checkInterval?: number;
    }
  ) {
    this.flyClient = flyClient;
    this.defaultPoolSize = options.defaultPoolSize;
    this.checkInterval = options.checkInterval || 60000;
  }

  /**
   * Start the machine pool management
   */
  async start(): Promise<void> {
    console.log('Starting pool manager...');
    // Initial pool check
    await this.checkPool();

    // Start periodic checks
    this.checkTimer = setInterval(() => this.checkPool(), this.checkInterval);
  }

  /**
   * Stop the machine pool management
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Check and maintain the machine pool
   */
  private async checkPool(): Promise<void> {
    try {
      const flyMachines = await this.flyClient.listFlyMachines();
      const flyMachineIds = new Set(flyMachines.filter(isFlyMachine).map(m => m.id));

      const callback: TransactionCallback<MachinePoolRecord[]> = async (tx: BasePrismaClient) => {
        const machines = await tx.machine_pool.findMany({
          where: { deleted: false },
          select: { machine_id: true }
        });
        const dbMachineIds = new Set(machines.map((m: { machine_id: string }) => m.machine_id));
        
        const machinesToDelete = machines.filter((m: { machine_id: string }) => !flyMachineIds.has(m.machine_id));
        if (machinesToDelete.length > 0) {
          await tx.machine_pool.updateMany({
            where: {
              machine_id: { in: machinesToDelete.map((m: { machine_id: string }) => m.machine_id) }
            },
            data: { deleted: true }
          });
        }

        const machinesToAdd = flyMachines.filter((m): m is FlyMachine => 
          isFlyMachine(m) && !dbMachineIds.has(m.id)
        );
        
        if (machinesToAdd.length > 0) {
          await tx.machine_pool.createMany({
            data: machinesToAdd.map(m => ({
              machine_id: m.id,
              ipv6: m.private_ip || '',
              deleted: false,
              is_available: true,
              created_at: new Date(m.created_at || Date.now()),
            })),
            skipDuplicates: true,
          });
        }
        return machines;
      };

      await prisma.$transaction(callback);

      const availableCount = await prisma.machine_pool.count({
        where: {
          is_available: true,
          deleted: false,
          assigned_to: null,
        }
      });

      if (availableCount < this.defaultPoolSize) {
        const toCreate = this.defaultPoolSize - availableCount;
        await this.createNewMachines(toCreate);
      }
    } catch (error) {
      console.error('Error checking machine pool:', error);
    }
  }

  /**
   * Get machine creation options
   */
  private async getMachineCreationOptions(): Promise<{
    name: string;
    region: string;
    image: string;
    env: {
      FLY_PROCESS_GROUP: string;
      PORT: string;
      PRIMARY_REGION: string;
    };
    services: {
      protocol: string;
      internal_port: number;
      ports: { port: number; handlers: string[] }[];
    }[];
    resources: {
      cpu_kind: string;
      cpus: number;
      memory_mb: number;
    };
  }> {
    const image = this.flyClient.getImageRef();
    if (!image) {
      throw new Error('Failed to get image reference');
    }

    return {
      name: `pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      region: "nrt",
      image,
      env: {
        FLY_PROCESS_GROUP: "worker",
        PORT: "30000",
        PRIMARY_REGION: "nrt"
      },
      services: [
        {
          protocol: "tcp",
          internal_port: 30000,
          ports: [
            { port: 80, handlers: ["http"] },
            { port: 443, handlers: ["tls", "http"] }
          ]
        }
      ],
      resources: {
        cpu_kind: "shared",
        cpus: 2,
        memory_mb: 2048
      }
    };
  }

  /**
   * Create multiple new machines in parallel and add them to the pool
   */
  private async createNewMachines(count: number): Promise<void> {
    try {
      const optionsList = await Promise.all(
        Array.from({ length: count }, () => this.getMachineCreationOptions())
      );

      const machines = await Promise.all(optionsList.map(opt => this.flyClient.createMachine(opt, 0)));
      const validMachines = machines.filter((m): m is FlyMachine => isFlyMachine(m));
      
      if (validMachines.length > 0) {
        const callback: TransactionCallback<void> = async (tx) => {
          await tx.machine_pool.createMany({
            data: validMachines.map(m => ({
              machine_id: m.id,
              ipv6: m.private_ip || '',
              deleted: false,
              is_available: true,
              created_at: new Date(m.created_at || Date.now()),
            })),
            skipDuplicates: true,
          });
        };

        await prisma.$transaction(callback);
      }
    } catch (error) {
      console.error('Error creating new machines:', error);
    }
  }

  /**
   * Create a new machine and assign it to a user in a single transaction
   */
  async createNewMachineWithUser(userId: string): Promise<string | null> {
    try {
      const options = await this.getMachineCreationOptions();
      const machine = await this.flyClient.createMachine(options, 0);
      if (!machine || !machine.id) {
        console.error('Failed to create new machine');
        return null;
      }

      // Create and assign machine in a single transaction
      const result = await prisma.$transaction(async (tx) => {
        const created = await tx.machine_pool.create({
          data: {
            machine_id: machine.id,
            ipv6: machine.private_ip || '',
            deleted: false,
            is_available: false,
            assigned_to: userId,
            assigned_at: new Date(),
            created_at: new Date(machine.created_at || Date.now()),
          }
        });
        return created.machine_id;
      });

      return result;
    } catch (error) {
      console.error('Error creating and assigning new machine:', error);
      return null;
    }
  }

  /**
   * Get an available machine from the pool
   */
  async getMachine(userId: string): Promise<string | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        // Get and update an available machine atomically
        const result = await tx.$queryRaw`
          UPDATE machine_pool
          SET
            assigned_to = ${userId},
            assigned_at = NOW(),
            is_available = false
          WHERE id = (
            SELECT id
            FROM machine_pool
            WHERE is_available = true
              AND deleted = false
            FOR UPDATE
            LIMIT 1
          )
          RETURNING machine_id
        `;

        if (!result || !Array.isArray(result) || result.length === 0) {
          console.log('No available machines in the pool');
          return null;
        }

        return result[0].machine_id;
      });
    } catch (error) {
      console.error('Error getting machine from pool:', error);
      return null;
    }
  }

  /**
   * Get machine assignment information
   */
  async getMachineAssignment(machineId: string): Promise<{ assigned_to: string | null; assigned_at: Date | null } | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        const machine = await tx.machine_pool.findFirst({
          where: { machine_id: machineId },
          select: { assigned_to: true, assigned_at: true }
        });

        if (!machine) {
          return {
            assigned_to: null,
            assigned_at: null
          };
        }

        return {
          assigned_to: machine.assigned_to,
          assigned_at: machine.assigned_at
        };
      });
    } catch (error) {
      console.error('Error getting machine assignment:', error);
      return {
        assigned_to: null,
        assigned_at: null
      };
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
    return await prisma.$transaction(async (tx) => {
      return await tx.machine_pool.findMany({
        where: { deleted: false },
      });
    });
  }

  /**
   * Returns a single machine by machine_id from the database (if not deleted).
   */
  async getMachineById(machineId: string): Promise<{
    machine_id: string;
    ipv6: string | null;
    deleted: boolean;
    assigned_to: string | null;
    assigned_at: Date | null;
    is_available: boolean;
    created_at: Date;
  } | null> {
    return await prisma.$transaction(async (tx) => {
      return await tx.machine_pool.findFirst({
        where: { machine_id: machineId, deleted: false },
      });
    });
  }

  /**
   * Gets the IP address of a machine.
   * @param machineId - ID of the machine
   * @returns The machine's IP address or null if not found
   */
  async getMachineIp(machineId: string): Promise<string | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        const machine = await tx.machine_pool.findFirst({
          where: { machine_id: machineId },
          select: { ipv6: true }
        });
        return machine?.ipv6 || null;
      });
    } catch (e: unknown) {
      console.error("Error getting machine IP:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /**
   * Soft delete a machine in the database, only if not in use
   * Returns true if actually soft deleted, false otherwise
   */
  async softDeleteMachine(machineId: string): Promise<boolean> {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const deleted = await tx.$queryRaw<{ machine_id: string }[]>`
          UPDATE machine_pool
          SET deleted = true
          WHERE machine_id = ${machineId}
            AND assigned_to IS NULL
          RETURNING machine_id
        `;
        return deleted.length > 0;
      });
      return result;
    } catch (error) {
      console.error('Error soft deleting machine:', error);
      return false;
    }
  }
}
