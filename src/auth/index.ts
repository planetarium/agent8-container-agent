import { createHash } from 'crypto';

interface AuthConfig {
  authServerUrl: string;
}

export class AuthManager {
  private readonly authServerUrl: string;
  private token: string | null = null;

  constructor(config: AuthConfig) {
    this.authServerUrl = config.authServerUrl;
  }

  async verifyToken(token: string): Promise<{ userUid: string, [key: string]: any }> {
    if (!token)
      throw new Error('Token is required');

    try {
      const response = await fetch(`${this.authServerUrl}/v1/auth/verify`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Token verification failed: ${response.statusText}`);
      }

      const userInfo = await response.json();
      if (!userInfo.userUid) throw new Error(`userUid doesn't exist in the response`);
      return userInfo;
    } catch (error) {
      throw new Error(`Error verifying token: ${error}`);
    }
  }

  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.replace(/^Bearer /, '');
  }
} 