import { ContainerServer } from "@/server";
import { ContainerConfigSchema } from "@/types";

function main() {
  const config = ContainerConfigSchema.parse({
    port: 3000,
    workdirName: "/workspace",
    coep: "credentialless",
    forwardPreviewErrors: true,
  });

  const server = new ContainerServer(config);

  try {
    // Handle shutdown gracefully
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exit(1);
}
