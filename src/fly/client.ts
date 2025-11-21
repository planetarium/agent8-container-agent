import { FlyConfig, Machine, CreateMachineOptions } from './types';
import { FlyError } from '../errors';
import { retryWithBackoff } from '../utils/retry';

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
   * Creates a Fly machine
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
        throw new FlyError(`Failed to create machine: ${res.statusText}`, res.status);
      }

      return await res.json();
    } catch (e: unknown) {
      // Propagate FlyError as is
      if (e instanceof FlyError) {
        throw e;
      }
      // Handle network errors as 503
      console.error("Fly API network error:", e instanceof Error ? e.message : e);
      throw new FlyError(
        `Fly API unavailable: ${e instanceof Error ? e.message : 'Unknown error'}`,
        503,
        true
      );
    }
  }

  /**
   * Destroys a machine from the Fly API.
   */
  async destroyMachine(machineId: string): Promise<void> {
    return retryWithBackoff(
      async () => {
        const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}?force=true`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          }
        });

        if (!res.ok) {
          throw new FlyError(`HTTP ${res.status} - ${res.statusText}`, res.status);
        }
      },
      {
        maxRetries: this.RETRY_LIMIT,
        shouldRetry: (error) => {
          // Don't retry 404 errors (machine already deleted)
          if (error instanceof FlyError && error.statusCode === 404) {
            return false;
          }
          return true;
        },
        onRetry: (error, attempt, delay) => {
          console.warn(`[FlyClient] destroyMachine retry attempt ${attempt + 1}/${this.RETRY_LIMIT}, waiting ${delay}ms...`);
        }
      }
    );
  }

  getImageRef(): string | undefined {
    return this.config.imageRef;
  }

  /**
   * Get real-time machine status from Fly API.
   * @param machineId - The ID of the machine to check
   * @returns Machine details and current status
   * @throws FlyError if machine not found or API error occurs
   */
  async getMachineStatus(machineId: string): Promise<Machine> {
    return retryWithBackoff(
      async () => {
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
              throw new FlyError(`Machine not found: ${machineId}`, 404);
            }
            throw new FlyError(`Failed to get machine status: ${res.statusText}`, res.status);
          }

          return await res.json() as Machine;
        } catch (e: unknown) {
          // Propagate FlyError as is
          if (e instanceof FlyError) {
            throw e;
          }
          // Handle network errors as 503
          console.error("Fly API network error:", e instanceof Error ? e.message : e);
          throw new FlyError(
            `Fly API unavailable: ${e instanceof Error ? e.message : 'Unknown error'}`,
            503,
            true
          );
        }
      },
      {
        maxRetries: this.RETRY_LIMIT,
        shouldRetry: (error) => {
          // Don't retry 404 errors
          if (error instanceof FlyError && error.statusCode === 404) {
            return false;
          }
          return true;
        },
        onRetry: (error, attempt, delay) => {
          console.warn(`[FlyClient] getMachineStatus retry attempt ${attempt + 1}/${this.RETRY_LIMIT}, waiting ${delay}ms...`);
        }
      }
    );
  }

  /**
   * Update machine metadata
   * @param machineId - The ID of the machine to update
   * @param metadata - The metadata to set
   */
  async updateMachineMetadata(machineId: string, key: string, value: string): Promise<void> {
    return retryWithBackoff(
      async () => {
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
            throw new FlyError(`HTTP ${res.status} - ${res.statusText}`, res.status);
          }
        } catch (e: unknown) {
          if (e instanceof FlyError) {
            throw e;
          }
          console.error("Fly API error (updateMachineMetadata):", e instanceof Error ? e.message : e);
          throw new FlyError(
            `Fly API unavailable: ${e instanceof Error ? e.message : 'Unknown error'}`,
            503,
            true
          );
        }
      },
      {
        maxRetries: this.RETRY_LIMIT,
        shouldRetry: (error) => {
          // Don't retry 404 errors (machine doesn't exist)
          if (error instanceof FlyError && error.statusCode === 404) {
            return false;
          }
          return true;
        },
        onRetry: (error, attempt, delay) => {
          console.warn(`[FlyClient] updateMachineMetadata retry attempt ${attempt + 1}/${this.RETRY_LIMIT}, waiting ${delay}ms...`);
        }
      }
    );
  }

  /**
   * Returns the list of actual machines from the Fly API.
   */
  async listFlyMachines(): Promise<any[]> {
    return retryWithBackoff(
      async () => {
        try {
          const res = await fetch(`${this.config.baseUrl}/apps/${this.config.appName}/machines`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.config.apiToken}`,
              Accept: "application/json",
            },
          });
          if (!res.ok) {
            throw new FlyError(`HTTP ${res.status} - ${res.statusText}`, res.status);
          }
          return await res.json();
        } catch (e: unknown) {
          if (e instanceof FlyError) {
            throw e;
          }
          console.error("Fly API error (listFlyMachines):", e instanceof Error ? e.message : e);
          throw new FlyError(
            `Fly API unavailable: ${e instanceof Error ? e.message : 'Unknown error'}`,
            503,
            true
          );
        }
      },
      {
        maxRetries: this.RETRY_LIMIT,
        onRetry: (error, attempt, delay) => {
          console.warn(`[FlyClient] listFlyMachines retry attempt ${attempt + 1}/${this.RETRY_LIMIT}, waiting ${delay}ms...`);
        }
      }
    ).catch((e: unknown) => {
      console.error("Fly API error (listFlyMachines) - returning empty array after retries:", e instanceof Error ? e.message : e);
      return [];
    });
  }

  /**
   * Get machine metadata
   * @param machineId - The ID of the machine to get metadata for
   * @returns The machine's metadata or null if not found
   */
  async getMachineMetadata(machineId: string): Promise<Record<string, string> | null> {
    return retryWithBackoff(
      async () => {
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
            throw new FlyError(`HTTP ${res.status} - ${res.statusText}`, res.status);
          }

          return await res.json();
        } catch (e: unknown) {
          if (e instanceof FlyError) {
            throw e;
          }
          console.error("Fly API error (getMachineMetadata):", e instanceof Error ? e.message : e);
          throw new FlyError(
            `Fly API unavailable: ${e instanceof Error ? e.message : 'Unknown error'}`,
            503,
            true
          );
        }
      },
      {
        maxRetries: this.RETRY_LIMIT,
        onRetry: (error, attempt, delay) => {
          console.warn(`[FlyClient] getMachineMetadata retry attempt ${attempt + 1}/${this.RETRY_LIMIT}, waiting ${delay}ms...`);
        }
      }
    ).catch((e: unknown) => {
      console.error("Fly API error (getMachineMetadata) - returning null after retries:", e instanceof Error ? e.message : e);
      return null;
    });
  }
}
