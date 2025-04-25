import { expect, test, describe } from "bun:test";
import { spawn } from "child_process";
import { ContainerAgentImpl } from "../../src/container-agent-impl";
import { promises as fs } from "fs";
import { join } from "path";

describe("Container Integration Tests", () => {
  const testWorkspace = join(process.cwd(), "test-workspace");
  const containerAgent = new ContainerAgentImpl({
    workdirName: testWorkspace,
    port: 3000,
    coep: "require-corp",
    forwardPreviewErrors: true,
  });

  test("should build and run container", async () => {
    // Build the container
    const buildResult = await new Promise((resolve, reject) => {
      const build = spawn(
        "docker",
        [
          "build",
          "-f",
          "Containerfile",
          "-t",
          "container-agent-test",
          "--cache-from",
          "container-agent-test",
          ".",
        ],
        {
          stdio: "inherit",
        }
      );
      build.on("close", (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`Build failed with code ${code}`));
      });
    });

    expect(buildResult).toBe(true);

    // Run the container in background
    const containerResult = await new Promise((resolve, reject) => {
      const container = spawn("docker", [
        "run",
        "--rm",
        "-d",
        "-v",
        `${testWorkspace}:/workspace`,
        "container-agent-test",
      ]);

      let containerId = "";
      container.stdout.on("data", (data) => {
        containerId = data.toString().trim();
      });

      container.on("close", async (code) => {
        if (code === 0 && containerId) {
          try {
            // Check if container is running
            const check = spawn("docker", ["ps", "-q", "-f", `id=${containerId}`]);
            let isRunning = false;
            check.stdout.on("data", () => {
              isRunning = true;
            });
            await new Promise((r) => check.on("close", r));

            if (isRunning) {
              // Stop the container
              spawn("docker", ["stop", containerId]);
              resolve(true);
            } else {
              reject(new Error("Container failed to start"));
            }
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`Container run failed with code ${code}`));
        }
      });
    });

    expect(containerResult).toBe(true);
  }, 30000);

  test("should handle file watching in container", async () => {
    const testFile = join(testWorkspace, "test.txt");
    const testContent = "Hello, Container!";

    // Create a test file
    await fs.writeFile(testFile, testContent);

    // Run the container with file watching
    const containerResult = await new Promise((resolve, reject) => {
      const container = spawn("docker", [
        "run",
        "--rm",
        "-d",
        "-v",
        `${testWorkspace}:/workspace`,
        "container-agent-test",
      ]);

      let containerId = "";
      container.stdout.on("data", (data) => {
        containerId = data.toString().trim();
      });

      container.on("close", async (code) => {
        if (code === 0 && containerId) {
          try {
            // Give some time for the container to start
            await new Promise((r) => setTimeout(r, 2000));

            // Modify the test file
            await fs.writeFile(testFile, testContent + " Updated");

            // Stop the container
            spawn("docker", ["stop", containerId]);
            resolve(true);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`Container run failed with code ${code}`));
        }
      });
    });

    expect(containerResult).toBe(true);

    // Cleanup
    await fs.unlink(testFile);
  }, 10000);
});
