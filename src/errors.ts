export class ServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public service: 'auth-server' | 'fly-api' | 'database' | 'internal',
    public isNetworkError: boolean = false
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class AuthError extends ServiceError {
  constructor(message: string, statusCode: number, isNetworkError: boolean = false) {
    super(message, statusCode, 'auth-server', isNetworkError);
    this.name = 'AuthError';
  }
}

export class FlyError extends ServiceError {
  constructor(message: string, statusCode: number, isNetworkError: boolean = false) {
    super(message, statusCode, 'fly-api', isNetworkError);
    this.name = 'FlyError';
  }
}

export class DatabaseError extends ServiceError {
  constructor(message: string, statusCode: number, isNetworkError: boolean = false) {
    super(message, statusCode, 'database', isNetworkError);
    this.name = 'DatabaseError';
  }
}
