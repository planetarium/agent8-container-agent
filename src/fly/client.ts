import { FlyConfig, Machine, CreateMachineOptions } from './types';

// 429 재시도 유틸 함수
async function fetchWith429Retry(input: RequestInfo, init?: RequestInit, maxRetries = 3): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(input, init);
    if (res.status !== 429) return res;
    attempt++;
    console.log(`429 response, attempt ${attempt}`);
    if (attempt > maxRetries) throw new Error('Too many 429 responses from Fly.io API');
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
  }
}

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
      const res = await fetchWith429Retry(`${this.config.baseUrl}/platform/regions`);
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
      const res = await fetchWith429Retry(`${this.config.baseUrl}/apps/${this.config.appName}/machines`, {
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
    const res = await fetchWith429Retry(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}?force=true`, {
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
      const res = await fetchWith429Retry(`${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}`, {
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
  async listFlyMachines(options?: { metadata?: Record<string, string> }): Promise<any[]> {
    try {
      const params = new URLSearchParams();
      if (options?.metadata) {
        for (const [key, value] of Object.entries(options.metadata)) {
          params.append(`metadata.${key}`, value);
        }
      }
      const url = `${this.config.baseUrl}/apps/${this.config.appName}/machines${params.toString() ? '?' + params.toString() : ''}`;
      console.log(url);
      const res = await fetchWith429Retry(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` }
      });
      if (!res.ok) throw new Error('Failed to list machines');
      return await res.json();
    } catch (e: unknown) {
      console.error("Fly API error (listFlyMachines):", e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * Create a lease for a machine (prevents other processes from using it)
   * https://fly.io/docs/machines/api/machines-resource/#create-a-machine-lease
   */
  async createMachineLease(machineId: string, ttlSeconds = 60): Promise<any> {
    const url = `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}/lease`;
    const res = await fetchWith429Retry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: ttlSeconds })
    });
    if (!res.ok) throw new Error('Failed to create machine lease');
    return await res.json();
  }

  /**
   * Release a lease for a machine
   * https://fly.io/docs/machines/api/machines-resource/#release-a-machine-lease
   */
  async releaseMachineLease(machineId: string): Promise<boolean> {
    const url = `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}/lease`;
    const res = await fetchWith429Retry(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`
      }
    });
    if (!res.ok) throw new Error('Failed to release machine lease');
    return true;
  }

  async getMachineMetadata(machineId: string): Promise<Record<string, string>> {
    const appName = this.config.appName; // 이미 FlyClient에 appName이 있다고 가정
    const url = `${this.config.baseUrl}/apps/${appName}/machines/${machineId}/metadata`;
    const res = await fetchWith429Retry(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`Failed to get metadata: ${res.statusText}`);
    return await res.json();
  }

  /**
   * Add or update machine metadata
   * https://fly.io/docs/machines/api/machines-resource/#add-or-update-machine-metadata
   */
  async setMachineMetadata(machineId: string, key: string, value: string): Promise<boolean> {
    const url = `${this.config.baseUrl}/apps/${this.config.appName}/machines/${machineId}/metadata/${key}`;
    const res = await fetchWith429Retry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value })
    });
    if (!res.ok) throw new Error(`Failed to set machine metadata: ${res.statusText}`);
    return true;
  }

}
