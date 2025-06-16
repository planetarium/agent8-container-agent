import { FlyClient } from "./client.ts";
import type {
  CreateMachineOptions,
  FlyConfig,
  Machine,
  MachineConfig,
  MachineMap,
  MachineMount,
  MachinePort,
  MachineResources,
  MachineService,
} from "./types.ts";

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

export function initializeFlyClient(config: FlyConfig): FlyClient {
  if (!flyClient) {
    flyClient = new FlyClient(config);
  }
  return flyClient;
}
