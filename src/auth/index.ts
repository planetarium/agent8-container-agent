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

  async verifyToken(token: string): Promise<boolean> {
    if (!token) return false;

    try {
      const response = await fetch(`${this.authServerUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        console.error('Token verification failed:', response.statusText);
        return false;
      }

      const result = await response.json();
      return result.valid === true;
    } catch (error) {
      console.error('Error verifying token:', error);
      return false;
    }
  }

  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.replace(/^Bearer /, '');
  }
} 