const BEARER_PREFIX_REGEX = /^Bearer /;

interface AuthConfig {
  authServerUrl: string;
}

export class AuthManager {
  private readonly authServerUrl: string;
  private token: string | null = null;

  constructor(config: AuthConfig) {
    this.authServerUrl = config.authServerUrl;
  }

  async verifyToken(token: string): Promise<{ userUid: string; [key: string]: any }> {
    if (!token) {
      throw new Error("Token is required");
    }

    try {
      const response = await fetch(`${this.authServerUrl}/v1/auth/verify`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Token verification failed: ${response.statusText}`);
      }

      const userInfo = (await response.json()) as { userUid?: string; [key: string]: any };
      if (!userInfo.userUid) {
        throw new Error(`userUid doesn't exist in the response`);
      }
      return { userUid: userInfo.userUid, ...userInfo };
    } catch (error) {
      throw new Error(`Error verifying token: ${error}`);
    }
  }

  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }
    return authHeader.replace(BEARER_PREFIX_REGEX, "");
  }
}

/**
 * Container Authentication Module
 *
 * Provides ECDSA P-256 based authentication for Agent8 containers.
 * Handles signature generation, JWT token management, and server communication.
 */

export {
  loadPrivateKey,
  signMessage,
  validateTimestamp,
  createContainerAuthRequest,
  type ContainerAuthRequest,
} from "./ecdsaUtil.js";

export {
  ContainerAuthClient,
  type ContainerJWTPayload,
  type AuthenticationResult,
  type JWTValidationResult,
} from "./jwtUtil.js";

export { getContainerAuthTokenForUser } from "../container/containerAuthClient.js";
