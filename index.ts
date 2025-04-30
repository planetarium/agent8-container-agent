import process from "node:process";
import { ContainerServer } from "@/server";
import { ContainerConfigSchema } from "@/types";
import { updateMachineMap } from "@/fly";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

function main() {
  const config = ContainerConfigSchema.parse({
    port: parseInt(process.env.PORT || "3000", 10),
    workdirName: process.env.WORKDIR_NAME || "/workspace",
    coep: process.env.COEP || "credentialless",
    forwardPreviewErrors: process.env.FORWARD_PREVIEW_ERRORS === "true",
  });

  const server = new ContainerServer(config);
  updateMachineMap();

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
