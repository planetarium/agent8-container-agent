import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContainerAgentImpl } from "@/container-agent-impl";
import type { PathWatcherEvent } from "@/types";
import { setupTestEnvironment, testConfig } from "./config.ts";

describe("Container Agent Integration Tests", () => {
  let agent: ContainerAgentImpl;

  beforeAll(async () => {
    await setupTestEnvironment();
    agent = new ContainerAgentImpl(testConfig);
  });

  afterAll(async () => {
    await agent.cleanup();
  });

  test("filesystem operations", async () => {
    // Test file write through mount
    const fileTree = {
      "test.txt": "Hello, World!",
    };
    await agent.mount(fileTree);

    // Test file read
    const content = await agent.fs.readFile("test.txt", { encoding: "utf-8" });
    expect(content).toBe("Hello, World!");

    // Test file write
    await agent.fs.writeFile("test2.txt", "New content");
    const content2 = await agent.fs.readFile("test2.txt", { encoding: "utf-8" });
    expect(content2).toBe("New content");

    // Test file delete
    await agent.fs.rm("test.txt");
    await agent.fs.rm("test2.txt");
  });

  test("terminal operations", async () => {
    // Test process spawn
    const process = await agent.spawn("node", ["-e", "console.log('Hello, World!');"]);
    expect(process.input).toBeDefined();
    expect(process.output).toBeDefined();

    // Test process input
    const writer = process.input.getWriter();
    await writer.write("test input\n");
    writer.releaseLock();

    // Wait for process to exit
    const exitCode = await process.exit;
    expect(exitCode).toBe(0);
  });

  test("preview operations", async () => {
    let portReceived = false;
    let serverReady = false;
    let messageReceived = false;

    // Set up event listeners
    const unsubPort = agent.on("port", (port) => {
      expect(port).toBe(3000);
      portReceived = true;
    });

    const unsubServerReady = agent.on("server-ready", () => {
      serverReady = true;
    });

    const unsubPreviewMessage = agent.on("preview-message", (message) => {
      expect(message.type).toBe("error");
      expect(message.message).toBe("Test error");
      messageReceived = true;
    });

    // Emit events
    agent.emit("port", 3000);
    agent.emit("server-ready");
    agent.emit("preview-message", {
      type: "error",
      message: "Test error",
    });

    // Clean up listeners
    unsubPort();
    unsubServerReady();
    unsubPreviewMessage();

    expect(portReceived).toBe(true);
    expect(serverReady).toBe(true);
    expect(messageReceived).toBe(true);
  });

  test("watch operations", async () => {
    // Create test directory and file
    const dirTree = {
      "watch-test": {
        "test.txt": "Initial content",
      },
    };
    await agent.mount(dirTree);

    let eventReceived = false;
    const callback = (event: PathWatcherEvent) => {
      // The event could be either "change" or "remove_file" followed by "add_file"
      expect(["change", "remove_file", "add_file"]).toContain(event.type);
      expect(event.path).toBe("test.txt");
      eventReceived = true;
    };

    // Start watching
    agent.internal.watchPaths({ pattern: "watch-test/test.txt", persistent: true }, callback);

    // Write a file to trigger watch
    await agent.fs.writeFile("watch-test/test.txt", "Watch test content");

    // Wait a bit for the watch event
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(eventReceived).toBe(true);

    // Cleanup
    await agent.fs.rm("watch-test", { recursive: true });
  });
});
