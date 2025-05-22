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

  async verifyToken(token: string): Promise<{ userUid: string, [key: string]: any } | null> {
    if (!token) return null;

    try {
      const response = await fetch(`${this.authServerUrl}/v1/auth/verify`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        console.error('Token verification failed:', response.statusText);
        return null;
      }

      const userInfo = await response.json();
      if (!userInfo.userUid) return null;
      return userInfo;
    } catch (error) {
      console.error('Error verifying token:', error);
      return null;
    }
  }

  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.replace(/^Bearer /, '');
  }
} 