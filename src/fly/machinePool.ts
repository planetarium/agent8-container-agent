import { FlyClient } from './client';
import { PrismaClient } from '@prisma/client';

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
  private readonly minPoolSize: number;
  private readonly maxPoolSize: number;
  private readonly checkInterval: number;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    flyClient: FlyClient,
    options: {
      minPoolSize: number;
      maxPoolSize: number;
      checkInterval?: number; // in milliseconds
    }
  ) {
    this.flyClient = flyClient;
    this.minPoolSize = options.minPoolSize;
    this.maxPoolSize = options.maxPoolSize;
    this.checkInterval = options.checkInterval || 60000; // default 1 minute
  }

  /**
   * Start the machine pool management
   */
  async start(): Promise<void> {
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
      // Get current pool status
      const machines = await prisma.machine_pool.findMany({
        where: { deleted: false }
      });

      const availableMachines = machines.filter((m: Machine) => m.is_available);
      const totalMachines = machines.length;

      console.log(`Pool status: ${availableMachines.length} available, ${totalMachines} total`);

      // Create new machines if needed
      if (availableMachines.length < this.minPoolSize && totalMachines < this.maxPoolSize) {
        const machinesToCreate = Math.min(
          this.minPoolSize - availableMachines.length,
          this.maxPoolSize - totalMachines
        );

        console.log(`Creating ${machinesToCreate} new machines`);
        for (let i = 0; i < machinesToCreate; i++) {
          await this.createNewMachine();
        }
      }

      // Remove excess machines if needed
      if (availableMachines.length > this.minPoolSize) {
        const machinesToRemove = availableMachines.length - this.minPoolSize;
        console.log(`Removing ${machinesToRemove} excess machines`);
        
        for (let i = 0; i < machinesToRemove; i++) {
          const machine = availableMachines[i];
          if (machine.machine_id) {
            await this.flyClient.destroyMachine(machine.machine_id);
          }
        }
      }
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
      // Get an available machine
      const machine = await prisma.machine_pool.findFirst({
        where: { 
          is_available: true,
          deleted: false 
        }
      });

      if (!machine) {
        return null;
      }

      // Mark the machine as assigned
      await prisma.machine_pool.update({
        where: { machine_id: machine.machine_id },
        data: { 
          assigned_to: token,
          assigned_at: new Date(),
          is_available: false
        }
      });

      return machine.machine_id;
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
      await prisma.machine_pool.update({
        where: { machine_id: machineId },
        data: { 
          assigned_to: null,
          assigned_at: null,
          is_available: true
        }
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
      const machine = await prisma.machine_pool.findFirst({
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
    } catch (error) {
      console.error('Error getting machine assignment:', error);
      return {
        assigned_to: null,
        assigned_at: null
      };
    }
  }
} 