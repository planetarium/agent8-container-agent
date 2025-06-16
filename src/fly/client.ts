import type { CreateMachineOptions, FlyConfig, Machine } from "./types.ts";

export class FlyClient {
  private config: FlyConfig;
  private fallbackRegions: string[] = [];
  private RETRY_LIMIT = 3;

  constructor(config: FlyConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || "https://api.machines.dev/v1",
    };
    this.updateFallbackRegions();
  }

  async updateFallbackRegions(): Promise<void> {
    if (this.fallbackRegions.length === 0) {
      const res = await fetch("https://api.machines.dev/v1/platform/regions");
      this.fallbackRegions = (
        (await res.json()) as { Regions: Record<string, unknown>[] }
      ).Regions.filter(
        (region) => !region.requires_paid_plan && (region.capacity as number) > 100,
      ).map((region) => region.code as string);
    }
  }

  /**
   * Creates a Fly machine
   * @param options - Machine creation options
   */
  async createMachine(options: CreateMachineOptions, retry = 0): Promise<Machine> {
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const randomIdx = Math.floor(Math.random() * this.fallbackRegions.length);
          return this.createMachine(
            { ...options, region: this.fallbackRegions[randomIdx] },
            retry + 1,
          );
        }
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
    const res = await fetch(
      `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}?force=true`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
    );

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
      const res = await fetch(
        `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            Accept: "application/json",
          },
        },
      );

      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }
        console.error(`HTTP ${res.status} - ${res.statusText}`);
        return null;
      }

      return (await res.json()) as Machine;
    } catch (e: unknown) {
      console.error("Fly API error:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /**
   * Update machine metadata
   * @param machineId - The ID of the machine to update
   * @param metadata - The metadata to set
   */
  async updateMachineMetadata(machineId: string, key: string, value: string): Promise<void> {
    try {
      const res = await fetch(
        `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}/metadata/${key}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ value }),
        }
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${res.statusText}`);
      }
    } catch (e: unknown) {
      console.error("Fly API error (updateMachineMetadata):", e instanceof Error ? e.message : e);
      throw e;
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

  /**
   * Get machine metadata
   * @param machineId - The ID of the machine to get metadata for
   * @returns The machine's metadata or null if not found
   */
  async getMachineMetadata(machineId: string): Promise<Record<string, string> | null> {
    try {
      const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}/metadata`, {
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

      return await res.json();
    } catch (e: unknown) {
      console.error("Fly API error (getMachineMetadata):", e instanceof Error ? e.message : e);
      return null;
    }
  }
}
