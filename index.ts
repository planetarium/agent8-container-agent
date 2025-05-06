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
    appHostName: process.env.APP_HOST_NAME || "localhost",
    machineId: process.env.FLY_MACHINE_ID || "",
    processGroup: process.env.FLY_PROCESS_GROUP || "app",
  };

  if (process.env.FLY_APP_NAME) {
    config.appHostName = `${process.env.FLY_APP_NAME}.fly.dev`;
  }

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
