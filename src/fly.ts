interface Machine {
    id: string;
    private_ip?: string;
  }
  
  interface MachineMap {
    [id: string]: string;
  }

const port = process.env.PORT || 3000;
const FLY_API_TOKEN = process.env.FLY_API_TOKEN;
const FLY_APP_NAME = process.env.FLY_APP_NAME;

  
let machineIPMap: MachineMap = {};

export function getMachineIPMap() {
    return machineIPMap;
}

export async function updateMachineMap(): Promise<void> {
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${FLY_API_TOKEN}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }

    const machines: Machine[] = await res.json();
    machineIPMap = {};

    machines.forEach((m) => {
      if (m.private_ip) {
        machineIPMap[m.id] = m.private_ip;
      }
    });
  } catch (e: any) {
    console.error('Fly API error:', e.message);
  }
}