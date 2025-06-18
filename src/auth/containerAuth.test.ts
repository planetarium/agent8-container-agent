/**
 * Container Authentication Tests
 *
 * Basic tests for ECDSA signature generation/verification and JWT utilities
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createContainerAuthRequest, signMessage, validateTimestamp } from "./ecdsaUtil.js";
import { ContainerAuthClient } from "./jwtUtil.js";
import { verifyContainerAuthRequest, verifySignature } from "./testUtils.js";

// Check if test keys exist
const hasTestKeys = existsSync("test_private_pkcs8.pem") && existsSync("test_public.pem");

describe("Container Authentication", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    if (hasTestKeys) {
      // Use real test keys if available
      const privateKeyPem = readFileSync("test_private_pkcs8.pem", "utf8");
      const publicKeyPem = readFileSync("test_public.pem", "utf8");

      process.env = {
        ...originalEnv,
        CONTAINER_PRIVATE_KEY_PEM: privateKeyPem,
        CONTAINER_PUBLIC_KEY_PEM: publicKeyPem,
        CONTAINER_TIMESTAMP_LIMIT_SECONDS: "300",
      };
    } else {
      // Skip crypto tests if no real keys available
      process.env = {
        ...originalEnv,
        CONTAINER_TIMESTAMP_LIMIT_SECONDS: "300",
      };
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Timestamp Validation", () => {
    test("should accept current timestamp", () => {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      expect(validateTimestamp(currentTimestamp)).toBe(true);
    });

    test("should reject old timestamp", () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
      expect(validateTimestamp(oldTimestamp)).toBe(false);
    });

    test("should reject future timestamp", () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 400;
      expect(validateTimestamp(futureTimestamp)).toBe(false);
    });
  });

  describe("Authentication Request", () => {
    test.skipIf(!hasTestKeys)("should create valid auth request", () => {
      const email = "test@example.com";
      const request = createContainerAuthRequest(email);

      expect(request.userEmail).toBe(email);
      expect(request.timestamp).toBeGreaterThan(0);
      expect(request.signature).toBeTruthy();
      expect(typeof request.signature).toBe("string");
    });

    test.skipIf(!hasTestKeys)("should verify valid auth request", () => {
      const email = "test@example.com";
      const request = createContainerAuthRequest(email);

      expect(verifyContainerAuthRequest(request)).toBe(true);
    });

    test.skipIf(!hasTestKeys)("should reject invalid signature", () => {
      const email = "test@example.com";
      const request = createContainerAuthRequest(email);
      request.signature = "invalid-signature";

      expect(verifyContainerAuthRequest(request)).toBe(false);
    });
  });

  describe("ECDSA Signature", () => {
    test.skipIf(!hasTestKeys)("should sign and verify message", () => {
      const email = "test@example.com";
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signMessage(email, timestamp);
      expect(signature).toBeTruthy();

      const isValid = verifySignature(email, timestamp, signature);
      expect(isValid).toBe(true);
    });

    test.skipIf(!hasTestKeys)("should reject tampered message", () => {
      const email = "test@example.com";
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signMessage(email, timestamp);
      const tamperedEmail = "tampered@example.com";

      const isValid = verifySignature(tamperedEmail, timestamp, signature);
      expect(isValid).toBe(false);
    });
  });

  describe("ContainerAuthClient", () => {
    test("should initialize with correct parameters", () => {
      const authServerUrl = "http://localhost:3000";
      const email = "test@example.com";

      const client = new ContainerAuthClient(authServerUrl, email);
      expect(client).toBeTruthy();

      const tokenInfo = client.getTokenInfo();
      expect(tokenInfo.token).toBeNull();
      expect(tokenInfo.isExpired).toBe(true);
    });

    test("should handle token info correctly", () => {
      const client = new ContainerAuthClient("http://localhost:3000", "test@example.com");

      const initialInfo = client.getTokenInfo();
      expect(initialInfo.token).toBeNull();
      expect(initialInfo.payload).toBeNull();
      expect(initialInfo.isExpired).toBe(true);
      expect(initialInfo.needsRenewal).toBe(true);
    });
  });
});

// Integration test helper (commented out - requires actual server)
/*
describe('Integration Tests', () => {
  test.skip('should authenticate with real server', async () => {
    // This test requires a running Agent8 server with container auth endpoint
    const authClient = new ContainerAuthClient('http://localhost:3000', 'test@example.com');

    try {
      const token = await authClient.authenticate();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    } catch (error) {
      console.log('Integration test skipped - server not available:', error);
    }
  });
});
*/
