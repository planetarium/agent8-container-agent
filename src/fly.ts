import process from "node:process";
import isPortReachable from 'is-port-reachable';


interface Machine {
  id: string;
  // biome-ignore lint/style/useNamingConvention: https://fly.io/docs/machines/api/machines-resource/#machine-properties
  private_ip?: string;
}

interface MachineMap {
  [id: string]: string;
}

const { FLY_API_TOKEN, FLY_APP_NAME } = process.env;

let machineIpMap: MachineMap = {};

export function getMachineIpMap() {
  return machineIpMap;
}

export async function updateMachineMap(): Promise<void> {
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines`, {
      method: "GET",
      headers: {
        // biome-ignore lint/style/useNamingConvention: HTTP Header
        Authorization: `Bearer ${FLY_API_TOKEN}`,
        // biome-ignore lint/style/useNamingConvention: HTTP Header
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }

    const machines: Machine[] = await res.json();
    machineIpMap = Object.fromEntries(
      machines.flatMap((m) => (m.private_ip ? [[m.id, m.private_ip]] : [])),
    );
  } catch (e: unknown) {
    console.error("Fly API error:", e instanceof Error ? e.message : e);
  }
}

export function watchPortReachable(
  host: string,
  port: number,
  onChange: (open: boolean) => void,
  {
    intervalMs = 500,
    timeoutMs = Infinity,
  }: { intervalMs?: number; timeoutMs?: number } = {}
): () => void {
  let cancelled = false;
  let lastStatus: boolean | undefined = undefined;

  const stop = () => { cancelled = true; };

  // 내부에서 비동기 감시 실행
  (async () => {
    const start = Date.now();

    while (!cancelled && (Date.now() - start < timeoutMs)) {
      const reachable = await isPortReachable(port, { host });

      if (reachable !== lastStatus) {
        onChange(reachable);
        lastStatus = reachable;
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
  })();

  return stop;
}