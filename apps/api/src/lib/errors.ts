export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super('NOT_FOUND', `${entity} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class BusinessError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 422, details);
  }
}
