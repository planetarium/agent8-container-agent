import { FlyConfig, Machine, CreateMachineOptions } from './types';

export class FlyClient {
  private config: FlyConfig;

  constructor(config: FlyConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://api.machines.dev/v1'
    };
  }

  /**
   * Creates a Fly machine
   * @param options - Machine creation options
   */
  async createMachine(options: CreateMachineOptions): Promise<Machine> {
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

      return await res.json();
    } catch (e: unknown) {
      console.error("Fly API error:", e instanceof Error ? e.message : e);
      throw e;
    }
  }

  /**
   * Destroys a machine from the Fly API.
   */
  async destroyMachine(machineId: string): Promise<void> {
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
   * Returns the list of actual machines from the Fly API.
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
