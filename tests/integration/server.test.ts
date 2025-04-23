import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContainerServer } from "@/server";
import type { ContainerResponse, ProcessResponse } from "@/types";
import { setupTestEnvironment, testConfig } from "./config.ts";
import { TestClient } from "./helpers.ts";

describe("Container Server Integration Tests", () => {
  let server: ContainerServer;
  let client: TestClient;

  beforeAll(async () => {
    await setupTestEnvironment();
    server = new ContainerServer(testConfig);
    client = new TestClient(`ws://localhost:${testConfig.port}`);
    await client.connect();
  });

  afterAll(async () => {
    client.close();
    await server.stop();
  });

  test("filesystem operations", async () => {
    // Test file write
    const writeResponse = await client.send({
      type: "filesystem",
      operation: {
        type: "write",
        path: "/test.txt",
        content: "Hello, World!",
      },
    });
    expect(writeResponse.response.success).toBe(true);

    // Test file read
    const readResponse = await client.send({
      type: "filesystem",
      operation: {
        type: "read",
        path: "/test.txt",
      },
    });
    expect(readResponse.response.success).toBe(true);
    expect(readResponse.response.data).toBe("Hello, World!");

    // Test file delete
    const deleteResponse = await client.send({
      type: "filesystem",
      operation: {
        type: "delete",
        path: "/test.txt",
      },
    });
    expect(deleteResponse.response.success).toBe(true);
  });

  test("terminal operations", async () => {
    // Test process spawn
    const spawnResponse = (await client.send({
      type: "terminal",
      operation: {
        type: "spawn",
        command: "node",
        args: ["-e", "console.log('Hello, World!')"],
      },
    })) as { response: ContainerResponse<ProcessResponse> };
    expect(spawnResponse.response.success).toBe(true);
    expect(spawnResponse.response.data?.pid).toBeDefined();

    const pid = spawnResponse.response.data?.pid;

    // Test process input
    const inputResponse = await client.send({
      type: "terminal",
      operation: {
        type: "input",
        pid,
        data: "Hello\n",
      },
    });
    expect(inputResponse.response.success).toBe(true);

    // Test process kill
    const killResponse = await client.send({
      type: "terminal",
      operation: {
        type: "kill",
        pid,
      },
    });
    expect(killResponse.response.success).toBe(true);
  });
});
