import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ApiError } from '../api-error';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  roles: string[];
  type: 'access';
}

export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers['authorization'];
    const token =
      header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;

    if (!token) {
      throw ApiError.unauthorized('Missing bearer token');
    }

    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      if (payload.type !== 'access') {
        throw new Error('wrong token type');
      }
      request.user = payload;
      return true;
    } catch {
      throw ApiError.unauthorized('Invalid or expired access token', 'TOKEN_INVALID');
    }
  }
}
