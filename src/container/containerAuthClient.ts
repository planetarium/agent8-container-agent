/**
 * Container Authentication Client
 *
 * This module provides per-task authentication for containers
 * to authenticate with Agent8 servers using ECDSA P-256 signatures.
 */

import { ContainerAuthClient } from '../auth/jwtUtil.js';

/**
 * Create a temporary container auth client for a specific user email
 * and get authentication token (used for per-task authentication)
 */
export async function getContainerAuthTokenForUser(authServerUrl: string, userEmail: string): Promise<string> {
  const tempClient = new ContainerAuthClient(authServerUrl, userEmail);
  return await tempClient.authenticate();
}
