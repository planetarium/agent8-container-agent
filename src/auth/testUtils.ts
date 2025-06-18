import { type KeyObject, createPublicKey, createVerify } from "node:crypto";

/**
 * ECDSA P-256 Test Utilities
 *
 * This module provides ECDSA P-256 signature verification functions
 * for testing purposes only. These functions are not used in production.
 */

let publicKey: KeyObject | null = null;

/**
 * Load ECDSA public key from environment variable (TEST ONLY)
 */
export function loadPublicKey(): KeyObject {
  if (publicKey) {
    return publicKey;
  }

  const publicKeyPem = process.env.CONTAINER_PUBLIC_KEY_PEM;
  if (!publicKeyPem) {
    throw new Error("CONTAINER_PUBLIC_KEY_PEM environment variable is required for testing");
  }

  try {
    publicKey = createPublicKey(publicKeyPem);
    return publicKey;
  } catch (error) {
    throw new Error(`Failed to load public key: ${error}`);
  }
}

/**
 * Verify ECDSA P-256 signature (TEST ONLY)
 */
export function verifySignature(userEmail: string, timestamp: number, signature: string): boolean {
  try {
    const message = `${userEmail}:${timestamp}`;
    const publicKeyObj = loadPublicKey();

    const verify = createVerify("sha256");
    verify.update(message);

    return verify.verify(publicKeyObj, signature, "base64");
  } catch (error) {
    console.error("[ECDSA-Test] Signature verification failed:", error);
    return false;
  }
}

/**
 * Verify complete container authentication request (TEST ONLY)
 */
export function verifyContainerAuthRequest(request: {
  userEmail: string;
  timestamp: number;
  signature: string;
}): boolean {
  const { userEmail, timestamp, signature } = request;

  // Import validateTimestamp from the main module
  const { validateTimestamp } = require("./ecdsaUtil.js");

  if (!validateTimestamp(timestamp)) {
    return false;
  }

  return verifySignature(userEmail, timestamp, signature);
}
