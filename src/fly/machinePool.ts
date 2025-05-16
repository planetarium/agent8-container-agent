import { FlyClient } from './client';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface Machine {
  machine_id: string;
  deleted: boolean;
  assigned_to: string | null;
  assigned_at: Date | null;
  ipv6: string | null;
  is_available: boolean;
}

export class MachinePool {
  private readonly flyClient: FlyClient;
  private readonly defaultPoolSize: number;
  private readonly checkInterval: number;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    flyClient: FlyClient,
    options: {
      defaultPoolSize: number;
      checkInterval?: number; // in milliseconds
    }
  ) {
    this.flyClient = flyClient;
    this.defaultPoolSize = options.defaultPoolSize;
    this.checkInterval = options.checkInterval || 60000; // default 1 minute
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
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. 실제 머신 상태 조회 (Fly API)
        const flyMachines = await this.flyClient.listFlyMachines();
        const flyMachineIds = new Set(flyMachines.map((m: any) => m.id));

        // 2. DB 상태 조회
        const dbMachines = await tx.machine_pool.findMany({ where: { deleted: false } });
        const dbMachineIds = new Set(dbMachines.map((m: any) => m.machine_id));

        // 3. DB에는 있는데 실제로 없는 머신 → soft delete
        for (const dbMachine of dbMachines) {
          if (!flyMachineIds.has(dbMachine.machine_id)) {
            await tx.machine_pool.updateMany({
              where: { machine_id: dbMachine.machine_id },
              data: { deleted: true }
            });
          }
        }

        // 4. 실제로는 있는데 DB에 없는 머신 → DB에 추가
        for (const flyMachine of flyMachines) {
          if (!dbMachineIds.has(flyMachine.id)) {
            await tx.machine_pool.create({
              data: {
                machine_id: flyMachine.id,
                ipv6: flyMachine.private_ip || '',
                deleted: false,
                is_available: true,
                created_at: new Date(flyMachine.created_at || Date.now()),
              }
            });
          }
        }

        // 5. 정상 머신만 카운트해서 풀 사이즈 유지
        const healthyMachines = flyMachines.filter((m: any) => m.state === 'started');
        if (healthyMachines.length < this.defaultPoolSize) {
          const toCreate = this.defaultPoolSize - healthyMachines.length;
          for (let i = 0; i < toCreate; i++) {
            await this.createNewMachine();
          }
        } else if (healthyMachines.length > this.defaultPoolSize) {
          const toDelete = healthyMachines.length - this.defaultPoolSize;
          for (let i = 0; i < toDelete; i++) {
            const machine = healthyMachines[i];
            await this.flyClient.destroyMachine(machine.id);
            await tx.machine_pool.updateMany({
              where: { machine_id: machine.id },
              data: { deleted: true }
            });
          }
        }
      });
    } catch (error) {
      console.error('Error checking machine pool:', error);
    }
  }

  /**
   * Create a new machine and add it to the pool
   */
  private async createNewMachine(): Promise<string | null> {
    try {
      const image = await this.flyClient.getImageRef();
      if (!image) {
        console.error('Failed to get image reference');
        return null;
      }

      const options = {
        name: `pool-${Date.now()}`,
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
          cpus: 1,
          memory_mb: 1024
        }
      };

<<<<<<< HEAD
      const machine = await this.flyClient.createMachine(options, 0);
=======
      const machine = await this.flyClient.createMachine(options);
>>>>>>> 0071d49 (Fix schema)
      if (!machine || !machine.id) {
        console.error('Failed to create machine: No machine or machine ID returned');
        return null;
      }

      return machine.id;
    } catch (error) {
      console.error('Error creating new machine:', error);
      return null;
    }
  }

  /**
   * Get an available machine from the pool
   */
  async getMachine(token: string): Promise<string | null> {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Get an available machine
        const machine = await tx.machine_pool.findFirst({
          where: {
            is_available: true,
            deleted: false
          }
        });

        if (!machine) {
          console.log('No available machines in the pool');
          return null;
        }

        // Mark the machine as assigned
        await tx.machine_pool.update({
          where: { machine_id: machine.machine_id },
          data: {
            assigned_to: token,
            assigned_at: new Date(),
            is_available: false
          }
        });

        return machine.machine_id;
      });
    } catch (error) {
      console.error('Error getting machine from pool:', error);
      return null;
    }
  }

  /**
   * Release a machine back to the pool
   */
  async releaseMachine(machineId: string): Promise<void> {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.machine_pool.update({
          where: { machine_id: machineId },
          data: {
            assigned_to: null,
            assigned_at: null,
            is_available: true
          }
        });
      });
    } catch (error) {
      console.error('Error releasing machine:', error);
    }
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
}
