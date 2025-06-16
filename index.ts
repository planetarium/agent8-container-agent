import process from "node:process";
import { ContainerServer } from "@/server";
import dotenv from "dotenv";
import { FlyClient } from "./src/fly/client.ts";
import { MachinePool } from "./src/fly/machinePool.ts";
import { type GitLabConfig, GitLabPoller } from "./src/gitlab/index.ts";

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
    agentUid: 2000,
  };

  console.info(`container agent started with ${config.processGroup} mode`);

  if (config.processGroup === "scheduler") {
    const flyClient = new FlyClient({
      apiToken: process.env.FLY_API_TOKEN || "",
      appName: process.env.TARGET_APP_NAME || "",
      imageRef: process.env.FLY_IMAGE_REF,
    });

    const machinePool = new MachinePool(flyClient, {
      defaultPoolSize: Number.parseInt(process.env.DEFAULT_POOL_SIZE || "20"),
      checkInterval: Number.parseInt(process.env.CHECK_INTERVAL || "60000"),
    });

    machinePool.start().catch(console.error);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.info("Scheduler received SIGINT, shutting down gracefully...");
      machinePool.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.info("Scheduler received SIGTERM, shutting down gracefully...");
      machinePool.stop();
      process.exit(0);
    });
  } else if (config.processGroup === "gitlab-poller") {
    // GitLab poller process
    const gitlabConfig: GitLabConfig = {
      url: process.env.GITLAB_URL || "",
      token: process.env.GITLAB_TOKEN || "",
      pollInterval: Number.parseInt(process.env.GITLAB_POLL_INTERVAL_MINUTES || "5"),
    };

    if (!(gitlabConfig.url && gitlabConfig.token)) {
      console.error("GITLAB_URL and GITLAB_TOKEN environment variables are required");
      process.exit(1);
    }

    const flyClient = new FlyClient({
      apiToken: process.env.FLY_API_TOKEN || "",
      appName: process.env.TARGET_APP_NAME || "",
      imageRef: process.env.FLY_IMAGE_REF,
    });

    // Use existing MachinePool with minimal changes
    const machinePool = new MachinePool(flyClient, {
      defaultPoolSize: Number.parseInt(process.env.DEFAULT_POOL_SIZE || "20"),
    });

    const gitlabPoller = new GitLabPoller(gitlabConfig, machinePool);

    gitlabPoller.start().catch((error) => {
      console.error("Failed to start GitLab poller:", error);
      process.exit(1);
    });

    // Handle graceful shutdown for GitLab poller
    process.on("SIGINT", () => {
      console.info("GitLab poller received SIGINT, shutting down gracefully...");
      gitlabPoller.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.info("GitLab poller received SIGTERM, shutting down gracefully...");
      gitlabPoller.stop();
      process.exit(0);
    });
  } else {
    const server = new ContainerServer(config);

    try {
      // Handle shutdown gracefully
      process.on("SIGINT", () => {
        console.info("Container server received SIGINT, shutting down gracefully...");
        server.stop();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        console.info("Container server received SIGTERM, shutting down gracefully...");
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
