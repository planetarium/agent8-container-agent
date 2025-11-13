import { createHash } from 'crypto';
import { AuthError } from '../errors';

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
    if (!token) {
      throw new AuthError('Token is required', 400);
    }

    try {
      const response = await fetch(`${this.authServerUrl}/v1/auth/verify`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        // 인증 서버의 실제 상태 코드를 전달
        throw new AuthError(
          `Token verification failed: ${response.statusText}`,
          response.status
        );
      }

      const userInfo = await response.json();
      if (!userInfo.userUid) {
        throw new AuthError(`userUid doesn't exist in the response`, 500);
      }
      return userInfo;
    } catch (error) {
      // fetch 자체가 실패한 경우 (네트워크 오류, 타임아웃 등)
      if (error instanceof AuthError) {
        throw error;
      }
      // 네트워크 오류는 503 (Service Unavailable)로 처리
      throw new AuthError(
        `Authentication service unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
        503,
        true  // 네트워크 오류 플래그
      );
    }
  }

  extractTokenFromHeader(authHeader: string | null): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.replace(/^Bearer /, '');
  }
} 