import { FlyClient } from './client';
import type {
  Machine,
  MachineMap,
  CreateMachineOptions,
  FlyConfig,
  MachineConfig,
  MachineService,
  MachinePort,
  MachineMount,
  MachineResources,
} from './types';

export {
  FlyClient,
  type Machine,
  type MachineMap,
  type CreateMachineOptions,
  type FlyConfig,
  type MachineConfig,
  type MachineService,
  type MachinePort,
  type MachineMount,
  type MachineResources,
};

// Create a singleton instance for backward compatibility
let flyClient: FlyClient | null = null;

export async function initializeFlyClient(config: FlyConfig): Promise<FlyClient> {
  if (!flyClient) {
    flyClient = new FlyClient(config);
  }
  return flyClient;
}
