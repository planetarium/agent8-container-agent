import process from "node:process";
import { ContainerServer } from "@/server";
import dotenv from "dotenv";

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

  console.info("Container agent started with " + config.processGroup + " mode");

  // Simplified: all instances run the same ContainerServer
  const server = new ContainerServer(config);

  try {
    // Handle shutdown gracefully
    process.on("SIGINT", () => {
      console.log("Received SIGINT, shutting down gracefully");
      server.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("Received SIGTERM, shutting down gracefully");
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
