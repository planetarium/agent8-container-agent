import { FlyClient } from './client';
// import { PrismaClient, Prisma } from '@prisma/client';
// const prisma = new PrismaClient();

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
    await this.checkPool();
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
      // 1. 할당되지 않은 머신만 바로 조회 (API에서 필터링)
      const available = await this.flyClient.listFlyMachines({
        metadata: { assigned_to: 'null' }
      });

      // 2. 풀 사이즈 유지: 부족할 때만 보충
      if (available.length < this.defaultPoolSize) {
        const toCreate = this.defaultPoolSize - available.length;
        await this.createNewMachines(toCreate);
      }
    } catch (error) {
      console.error('Error checking machine pool:', error);
    }
  }

  /**
   * Get machine creation options
   */
  private async getMachineCreationOptions(): Promise<any> {
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
   * Create multiple new machines in parallel and add them to the pool
   */
  private async createNewMachines(count: number): Promise<void> {
    try {
      const optionsList = await Promise.all(
        Array.from({ length: count }, () => this.getMachineCreationOptions())
      );
      // Fly API에 병렬로 머신 생성 요청
      const machines = await Promise.all(optionsList.map(opt => this.flyClient.createMachine(opt, 0)));
      const validMachines = machines.filter(m => m && m.id);
      for (const m of validMachines) {
        // 머신 풀에 등록: assigned_to를 빈 문자열로 설정
        await this.flyClient.setMachineMetadata(m.id, 'assigned_to', 'null');
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
      // 머신 할당 정보 메타데이터로 등록: assigned_to에 userId 저장
      await this.flyClient.setMachineMetadata(machine.id, 'assigned_to', userId);
      await this.flyClient.setMachineMetadata(machine.id, 'assigned_at', new Date().toISOString());
      return machine.id;
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
      // 1. 할당되지 않은 머신 목록 조회
      const available = await this.flyClient.listFlyMachines({
        metadata: { assigned_to: 'null' }
      });

      for (const m of available) {
        try {
          // 2. lease 시도
          await this.flyClient.createMachineLease(m.id, 60);
          // 3. 할당 정보 메타데이터로 등록
          await this.flyClient.setMachineMetadata(m.id, 'assigned_to', userId);
          await this.flyClient.setMachineMetadata(m.id, 'assigned_at', new Date().toISOString());
          // 4. lease 해제
          await this.flyClient.releaseMachineLease(m.id);
          return m.id;
        } catch (e) {
          console.warn('Error getting machine from pool:', e);
          // lease 실패 시 다음 머신으로
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
      // 모든 머신에서 실패 시 null 반환
      return null;
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
      // Replace with Fly API call (할당 정보 조회)
      const metadata = await this.flyClient.getMachineMetadata(machineId);
      const assigned_to = metadata.assigned_to ?? null;
      const assigned_at = metadata.assigned_at ? new Date(metadata.assigned_at) : null;
      return { assigned_to, assigned_at };
    } catch (error) {
      console.error('Error getting machine assignment:', error);
      return {
        assigned_to: null,
        assigned_at: null
      };
    }
  }
}
