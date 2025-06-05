import process from "node:process";
import { ContainerServer } from "@/server";
import dotenv from "dotenv";
import { MachinePool } from "./src/fly/machinePool";
import { FlyClient } from "./src/fly";

// Load environment variables from .env file
dotenv.config();

function main() {
  const config = {
    port: Number.parseInt(process.env.PORT || "3000", 10),
    workdirName: process.env.WORKDIR_NAME || "/workspace",
    coep: process.env.COEP || "credentialless",
    forwardPreviewErrors: process.env.FORWARD_PREVIEW_ERRORS === "true",
    routerDomain: process.env.FLY_ROUTER_DOMAIN || "agent8.verse8.net",
    appName: process.env.FLY_APP_NAME || "",
    machineId: process.env.FLY_MACHINE_ID || "",
    processGroup: process.env.FLY_PROCESS_GROUP || "app",
  };

  console.info("container agent started with " + config.processGroup + " mode");

  if (config.processGroup === "scheduler") {
    const flyClient = new FlyClient({
      apiToken: process.env.FLY_API_TOKEN || '',
      appName: process.env.TARGET_APP_NAME || '',
      imageRef: process.env.FLY_IMAGE_REF
    });

    const machinePool = new MachinePool(flyClient, {
      defaultPoolSize: parseInt(process.env.DEFAULT_POOL_SIZE || '20'),
      checkInterval: parseInt(process.env.CHECK_INTERVAL || '60000')
    });

    machinePool.start().catch(console.error);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      machinePool.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      machinePool.stop();
      process.exit(0);
    });
  } else {
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
}

try {
  main();
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exit(1);
}
