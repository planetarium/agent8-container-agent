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
      type: "writeFile",
      operation: {
        type: "writeFile",
        path: "/test.txt",
        content: "Hello, World!",
      },
    });
    expect(writeResponse.success).toBe(true);

    // Test file read
    const readResponse = (await client.send({
      type: "readFile",
      operation: {
        type: "readFile",
        path: "/test.txt",
      },
    })) as ContainerResponse<{ content: string }>;
    expect(readResponse.success).toBe(true);
    expect(readResponse.data?.content).toBe("Hello, World!");

    // Test file delete
    const deleteResponse = await client.send({
      type: "rm",
      operation: {
        type: "rm",
        path: "/test.txt",
      },
    });
    expect(deleteResponse.success).toBe(true);
  });

  test("terminal operations", async () => {
    // Test process spawn
    const spawnResponse = (await client.send({
      type: "spawn",
      operation: {
        type: "spawn",
        command: "node",
        args: ["-e", "console.log('Hello, World!')"],
      },
    })) as ContainerResponse<ProcessResponse>;
    expect(spawnResponse.success).toBe(true);
    expect(spawnResponse.data?.pid).toBeDefined();

    const pid = spawnResponse.data?.pid;

    // Test process input
    const inputResponse = await client.send({
      type: "input",
      operation: {
        type: "input",
        pid,
        data: "Hello\n",
      },
    });
    expect(inputResponse.success).toBe(true);

    // Test process kill
    const killResponse = await client.send({
      type: "kill",
      operation: {
        type: "kill",
        pid,
      },
    });
    expect(killResponse.success).toBe(true);
  });
});
