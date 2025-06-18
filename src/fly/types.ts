export interface Machine {
  id: string;
  name?: string;
  private_ip?: string;
  state?: string;
  region?: string;
  image?: string;
  created_at?: string;
  updated_at?: string;
  config?: MachineConfig;
}

export interface MachineConfig {
  image: string;
  env?: Record<string, string>;
  services?: MachineService[];
  mounts?: MachineMount[];
  resources?: MachineResources;
}

export interface MachineService {
  ports: MachinePort[];
  protocol: string;
  internal_port: number;
}

export interface MachinePort {
  port: number;
  handlers: string[];
}

export interface MachineMount {
  volume: string;
  path: string;
}

export interface MachineResources {
  cpu_kind: string;
  cpus: number;
  memory_mb: number;
}

export interface MachineMap {
  [id: string]: string;
}

export interface CreateMachineOptions {
  name?: string;
  region?: string;
  image: string;
  env?: Record<string, string>;
  services?: MachineService[];
  mounts?: MachineMount[];
  resources?: MachineResources;
}

export interface FlyConfig {
  apiToken: string;
  appName: string;
  imageRef?: string;
  baseUrl?: string;
}
