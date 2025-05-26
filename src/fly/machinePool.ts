import { FlyClient } from './client';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export class MachinePool {
  private readonly flyClient: FlyClient;
  private readonly targetBufferSize: number;
  private readonly maxCreationBatch: number;
  private readonly initialBufferSize: number;

  // Lock IDs for advisory locks
  private static readonly REPLENISH_LOCK_ID = 100001;
  private static readonly CREATE_LOCK_ID = 100002;

  constructor(
    flyClient: FlyClient,
    options?: {
      targetBufferSize?: number;
      maxCreationBatch?: number;
      initialBufferSize?: number;
    }
  ) {
    this.flyClient = flyClient;

    // Pool size configuration with environment variable fallbacks
    this.targetBufferSize = options?.targetBufferSize ??
      parseInt(process.env.MACHINE_POOL_TARGET_SIZE || '3');

    this.maxCreationBatch = options?.maxCreationBatch ??
      parseInt(process.env.MACHINE_POOL_MAX_BATCH || '2');

    this.initialBufferSize = options?.initialBufferSize ??
      parseInt(process.env.MACHINE_POOL_INITIAL_SIZE || '2');

    console.log(`[MachinePool] Initialized with target: ${this.targetBufferSize}, max batch: ${this.maxCreationBatch}, initial: ${this.initialBufferSize}`);
  }

  /**
   * Schedule background replenishment if needed (non-blocking)
   */
  async scheduleReplenishIfNeeded(): Promise<void> {
    try {
      // Try to acquire non-blocking session-level advisory lock
      const lockAcquired = await prisma.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${MachinePool.REPLENISH_LOCK_ID}) as acquired
      `;

      if (!lockAcquired[0]?.acquired) {
        console.log('[Replenish] Another process is already replenishing, skipping');
        return;
      }

      console.log('[Replenish] Lock acquired, starting replenishment');

      // Perform replenishment with lock held
      await this.performReplenishment();

    } catch (error) {
      console.error('[Replenish] Error during replenishment:', error);
    } finally {
      // Always release the lock
      try {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${MachinePool.REPLENISH_LOCK_ID})`;
        console.log('[Replenish] Lock released');
      } catch (unlockError) {
        console.error('[Replenish] Failed to release lock:', unlockError);
      }
    }
  }

    /**
   * Perform actual replenishment work
   */
  private async performReplenishment(): Promise<void> {
    // Double-checked locking: verify state after acquiring lock
    const currentAvailable = await this.getAvailableCount();

    if (currentAvailable >= this.targetBufferSize) {
      console.log(`[Replenish] Buffer sufficient (${currentAvailable}/${this.targetBufferSize})`);
      return;
    }

    const toCreate = Math.min(
      this.targetBufferSize - currentAvailable,
      this.maxCreationBatch
    );

    console.info(`[Replenish] Creating ${toCreate} machines (current: ${currentAvailable}, target: ${this.targetBufferSize})`);

    try {
      await this.createNewMachines(toCreate);
      console.info(`[Replenish] Successfully completed replenishment`);
    } catch (error) {
      console.error('[Replenish] Failed to create machines:', error);
      throw error;
    }
  }

  /**
   * Create new machines for the pool (protected by session lock)
   */
  private async createNewMachines(count: number): Promise<void> {
    if (count <= 0) return;

    try {
      // 1. Create machines via Fly API
      console.log(`[Create] Starting creation of ${count} machines`);

      const optionsList = await Promise.all(
        Array.from({ length: count }, () => this.getMachineCreationOptions())
      );

      const machines = await Promise.all(
        optionsList.map(async (opt, index) => {
          try {
            console.log(`[Create] Creating machine ${index + 1}/${count}`);
            return await this.flyClient.createMachine(opt, 0);
          } catch (error) {
            console.error(`[Create] Failed to create machine ${index + 1}:`, error);
            return null;
          }
        })
      );

      const validMachines = machines.filter(m => m && m.id);
      console.log(`[Create] Successfully created ${validMachines.length}/${count} machines via Fly API`);

      if (validMachines.length === 0) {
        console.warn('[Create] No valid machines created');
        return;
      }

      // 2. Save to database with UPSERT to prevent duplicates
      await this.saveMachinesToDB(validMachines);

    } catch (error) {
      console.error('[Create] Error in createNewMachines:', error);
      throw error;
    }
  }

  /**
   * Save machines to database using UPSERT pattern
   */
  private async saveMachinesToDB(machines: any[]): Promise<void> {
    console.log(`[DB] Saving ${machines.length} machines to database`);

    await prisma.$transaction(async (tx) => {
      let savedCount = 0;

      for (const machine of machines) {
        try {
          await tx.machine_pool.upsert({
            where: { machine_id: machine.id },
            update: {
              deleted: false,
              is_available: true,
              ipv6: machine.private_ip || '',
            },
            create: {
              machine_id: machine.id,
              ipv6: machine.private_ip || '',
              deleted: false,
              is_available: true,
              created_at: new Date(machine.created_at || Date.now()),
            }
          });
          savedCount++;
        } catch (error) {
          console.error(`[DB] Failed to save machine ${machine.id}:`, error);
          // Individual machine failure doesn't stop the whole batch
        }
      }

      console.log(`[DB] Successfully saved ${savedCount}/${machines.length} machines`);
    });
  }

  /**
   * Create a new machine and assign it to a user immediately
   */
  async createNewMachineWithUser(userId: string): Promise<string | null> {
    try {
      // Acquire blocking lock for sequential processing
      const lockAcquired = await prisma.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_advisory_lock(${MachinePool.CREATE_LOCK_ID}) as acquired
      `;

      console.log(`[UserCreate] Lock acquired for user ${userId}`);

      const options = await this.getMachineCreationOptions();
      const machine = await this.flyClient.createMachine(options, 0);

      if (!machine || !machine.id) {
        console.error('[UserCreate] Failed to create machine via Fly API');
        return null;
      }

      console.log(`[UserCreate] Created machine ${machine.id} for user ${userId}`);

      // Save to DB and assign to user
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

      console.log(`[UserCreate] Successfully assigned machine ${result} to user ${userId}`);
      return result;

    } catch (error) {
      console.error(`[UserCreate] Error creating machine for user ${userId}:`, error);
      return null;
    } finally {
      // Release lock
      try {
        await prisma.$queryRaw`SELECT pg_advisory_unlock(${MachinePool.CREATE_LOCK_ID})`;
        console.log(`[UserCreate] Lock released for user ${userId}`);
      } catch (unlockError) {
        console.error('[UserCreate] Failed to release lock:', unlockError);
      }
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
        PORT: "3000",
        PRIMARY_REGION: "nrt"
      },
      services: [
        {
          protocol: "tcp",
          internal_port: 3000,
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
   * Get an available machine from the pool and assign to user
   */
  async getMachine(userId: string): Promise<string | null> {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
          console.log(`[GetMachine] No available machines for user ${userId}`);
          return null;
        }

        const machineId = result[0].machine_id;
        console.log(`[GetMachine] Assigned machine ${machineId} to user ${userId}`);
        return machineId;
      });
    } catch (error) {
      console.error(`[GetMachine] Error getting machine for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Get the count of available machines
   */
  async getAvailableCount(): Promise<number> {
    const count = await prisma.machine_pool.count({
      where: {
        is_available: true,
        deleted: false,
        assigned_to: null,
      }
    });

    console.log(`[Count] Available machines: ${count}`);
    return count;
  }

  /**
   * Get the initial buffer size for warmup
   */
  getInitialBufferSize(): number {
    return this.initialBufferSize;
  }

  /**
   * Get current pool configuration
   */
  getPoolConfig(): {
    targetBufferSize: number;
    maxCreationBatch: number;
    initialBufferSize: number;
  } {
    return {
      targetBufferSize: this.targetBufferSize,
      maxCreationBatch: this.maxCreationBatch,
      initialBufferSize: this.initialBufferSize,
    };
  }

  /**
   * Get machine assignment information
   */
  async getMachineAssignment(machineId: string): Promise<{ assigned_to: string | null; assigned_at: Date | null } | null> {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
   * Returns all non-deleted machines from the database
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
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return await tx.machine_pool.findMany({
        where: { deleted: false },
      });
    });
  }

  /**
   * Returns a single machine by machine_id from the database (if not deleted)
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
    return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return await tx.machine_pool.findFirst({
        where: { machine_id: machineId, deleted: false },
      });
    });
  }

  /**
   * Gets the IP address of a machine
   * @param machineId - ID of the machine
   * @returns The machine's IP address or null if not found
   */
  async getMachineIp(machineId: string): Promise<string | null> {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

  /**
   * Clean up orphaned machines (optional cleanup method)
   */
  async cleanupOrphanedMachines(): Promise<void> {
    try {
      console.log('[Cleanup] Starting orphaned machine cleanup');

      // Get actual machines from Fly API
      const flyMachines = await this.flyClient.listFlyMachines();
      const flyMachineIds = new Set(flyMachines.map((m: any) => m.id));

      // Find machines in DB that don't exist in Fly
      const orphanedMachines = await prisma.machine_pool.findMany({
        where: {
          deleted: false,
          machine_id: {
            notIn: Array.from(flyMachineIds)
          }
        }
      });

      if (orphanedMachines.length > 0) {
        await prisma.machine_pool.updateMany({
          where: {
            machine_id: { in: orphanedMachines.map(m => m.machine_id) }
          },
          data: { deleted: true }
        });

        console.log(`[Cleanup] Marked ${orphanedMachines.length} orphaned machines as deleted`);
      } else {
        console.log('[Cleanup] No orphaned machines found');
      }
    } catch (error) {
      console.error('[Cleanup] Error during cleanup:', error);
    }
  }
}
