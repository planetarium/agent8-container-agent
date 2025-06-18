/**
 * JWT Utilities for Container Authentication
 *
 * This module provides JWT token management specifically for container authentication,
 * including token generation, validation, and automatic renewal.
 */

export interface ContainerJWTPayload {
  user: string;
  isContainer: boolean;
  iat?: number;
  exp?: number;
}

export interface AuthenticationResult {
  accessToken: string;
  isNewUser: boolean;
}

export interface JWTValidationResult {
  valid: boolean;
  payload?: ContainerJWTPayload;
  error?: string;
  needsRenewal?: boolean;
}

/**
 * Container authentication client for Agent8 server
 */
export class ContainerAuthClient {
  private currentToken: string | null = null;
  private tokenPayload: ContainerJWTPayload | null = null;
  private authServerUrl: string;
  private email: string;
  private renewalThresholdMinutes: number;

  constructor(authServerUrl: string, email: string, renewalThresholdMinutes = 10) {
    this.authServerUrl = authServerUrl;
    this.email = email;
    this.renewalThresholdMinutes = renewalThresholdMinutes;
  }

  /**
   * Authenticate with Agent8 server and receive JWT token
   */
  async authenticate(): Promise<string> {
    const { createContainerAuthRequest } = require("./ecdsaUtil.ts");

    try {
      const authRequest = createContainerAuthRequest(this.email);

      const response = await fetch(`${this.authServerUrl}/auth/container`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(authRequest),
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const result = (await response.json()) as AuthenticationResult;

      if (!result.accessToken) {
        throw new Error("No access token received from authentication server");
      }

      this.setToken(result.accessToken);

      return result.accessToken;
    } catch (error) {
      console.error("[ContainerAuth] Authentication failed:", error);
      throw error;
    }
  }

  /**
   * Get valid token with automatic renewal
   */
  async getValidToken(): Promise<string> {
    if (!this.currentToken || this.isExpired()) {
      return await this.authenticate();
    }

    if (this.needsRenewal()) {
      try {
        return await this.authenticate();
      } catch (error) {
        console.warn("[ContainerAuth] Token renewal failed, using existing token:", error);
        if (this.currentToken && !this.isExpired()) {
          return this.currentToken;
        }
        throw error;
      }
    }

    return this.currentToken;
  }

  /**
   * Make authenticated request with automatic token management
   */
  async authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getValidToken();

    const headers = {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }

  /**
   * Store JWT token and decode payload
   */
  private setToken(token: string): void {
    this.currentToken = token;
    this.tokenPayload = this.decodeJWTPayload(token);
  }

  /**
   * Check if current token needs renewal
   */
  private needsRenewal(): boolean {
    if (!this.tokenPayload?.exp) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    const renewalTime = this.tokenPayload.exp - this.renewalThresholdMinutes * 60;

    return now >= renewalTime;
  }

  /**
   * Check if current token is expired
   */
  private isExpired(): boolean {
    if (!this.tokenPayload?.exp) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    return now >= this.tokenPayload.exp;
  }

  /**
   * Decode JWT payload for internal use
   */
  private decodeJWTPayload(token: string): ContainerJWTPayload | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return payload as ContainerJWTPayload;
    } catch (error) {
      console.error("[ContainerAuth] Failed to decode JWT payload:", error);
      return null;
    }
  }

  /**
   * Get current token information
   */
  getTokenInfo(): {
    token: string | null;
    payload: ContainerJWTPayload | null;
    needsRenewal: boolean;
    isExpired: boolean;
  } {
    return {
      token: this.currentToken,
      payload: this.tokenPayload,
      needsRenewal: this.needsRenewal(),
      isExpired: this.isExpired(),
    };
  }
}
