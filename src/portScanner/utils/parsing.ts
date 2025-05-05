export function parseIpAddress(hex: string): string {
	if (hex.length === 8) {
		// IPv4
		const ip = [];
		for (let i = 0; i < hex.length; i += 2) {
			ip.push(parseInt(hex.substring(i, i + 2), 16));
		}
		return ip.reverse().join('.');
	} else {
		// IPv6 (간단한 구현 - 필요에 따라 확장)
		return 'localhost';
	}
}

export function parseLinuxSocketInfo(stdout: string): Record<string, { pid: number; socket: number }> {
	const socketMap: Record<string, { pid: number; socket: number }> = {};
	const lines = stdout.split('\n');

	for (const line of lines) {
		const match = /\/proc\/(\d+)\/fd\/\d+.*?socket:\[(\d+)\]/.exec(line);
		if (match) {
			const pid = parseInt(match[1], 10);
			const socket = parseInt(match[2], 10);
			socketMap[socket] = { pid, socket };
		}
	}

	return socketMap;
}

export function parseNetworkTables(tcp: string, tcp6: string): { socket: number; ip: string; port: number }[] {
	const connections: { socket: number; ip: string; port: number }[] = [];

	const processTable = (table: string) => {
		const lines = table.split('\n');
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;

			const parts = line.split(/\s+/);
			if (parts.length < 10) continue;

			// 상태 값 확인 (10은 LISTEN)
			if (parts[3] === '0A' || parts[3].toLowerCase() === '0a') {
				const socket = parseInt(parts[9], 10);
				const addressParts = parts[1].split(':');
				if (addressParts.length === 2) {
					const ip = parseIpAddress(addressParts[0]);
					const port = parseInt(addressParts[1], 16);
					connections.push({ socket, ip, port });
				}
			}
		}
	};

	if (tcp) processTable(tcp);
	if (tcp6) processTable(tcp6);

	return connections;
}

export function parseWindowsNetstat(output: string): { host: string; port: number; pid?: number }[] {
	const ports: { host: string; port: number; pid?: number }[] = [];
	const lines = output.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('TCP') || trimmed.startsWith('UDP')) {
			const parts = trimmed.split(/\s+/);
			if (parts.length >= 5) {
				const addressParts = parts[1].split(':');
				if (addressParts.length === 2) {
					const host = addressParts[0];
					const port = parseInt(addressParts[1], 10);
					const state = parts[3]; // LISTENING, ESTABLISHED 등
					const pid = parseInt(parts[4], 10);

					if (state === 'LISTENING' && !isNaN(port) && !isNaN(pid)) {
						ports.push({
							host: host === '0.0.0.0' ? 'localhost' : host,
							port,
							pid
						});
					}
				}
			}
		}
	}

	return ports;
}
