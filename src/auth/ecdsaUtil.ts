import { type KeyObject, createPrivateKey, createSign } from "node:crypto";

/**
 * ECDSA P-256 Container Authentication Utilities
 *
 * This module provides ECDSA P-256 signature generation and verification
 * for container authentication using environment variables for key management.
 */

export interface ContainerAuthRequest {
  userEmail: string;
  timestamp: number;
  signature: string;
}

let privateKey: KeyObject | null = null;

/**
 * Load ECDSA private key from environment variable
 */
export function loadPrivateKey(): KeyObject {
  if (privateKey) {
    return privateKey;
  }

  const privateKeyPem = process.env.CONTAINER_PRIVATE_KEY_PEM;
  if (!privateKeyPem) {
    throw new Error("CONTAINER_PRIVATE_KEY_PEM environment variable is required");
  }

  try {
    privateKey = createPrivateKey(privateKeyPem);
    return privateKey;
  } catch (error) {
    throw new Error(`Failed to load private key: ${error}`);
  }
}

/**
 * Generate ECDSA P-256 signature for userEmail:timestamp format
 */
export function signMessage(userEmail: string, timestamp: number): string {
  const message = `${userEmail}:${timestamp}`;
  const privateKeyObj = loadPrivateKey();

  const sign = createSign("sha256");
  sign.update(message);

  return sign.sign(privateKeyObj, "base64");
}

/**
 * Validate timestamp within allowed time window
 */
export function validateTimestamp(timestamp: number): boolean {
  const now = Date.now();
  const timestampMs = timestamp * 1000;
  const timeLimitSeconds = Number.parseInt(
    process.env.CONTAINER_TIMESTAMP_LIMIT_SECONDS || "300",
    10,
  );
  const timeLimitMs = timeLimitSeconds * 1000;

  const timeDiff = Math.abs(now - timestampMs);

  if (timeDiff > timeLimitMs) {
    console.warn(
      `[ECDSA] Timestamp validation failed: time difference ${timeDiff}ms exceeds limit ${timeLimitMs}ms`,
    );
    return false;
  }

  return true;
}

/**
 * Create complete container authentication request
 */
export function createContainerAuthRequest(userEmail: string): ContainerAuthRequest {
  const timestamp = Math.floor(Date.now() / 1000);

  if (!validateTimestamp(timestamp)) {
    throw new Error("Generated timestamp is invalid");
  }

  const signature = signMessage(userEmail, timestamp);

  return {
    userEmail,
    timestamp,
    signature,
  };
}
