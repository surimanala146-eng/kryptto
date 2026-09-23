import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';
import type { Request } from 'express';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    if (!request.user) {
      throw new Error('CurrentUser used outside of an authenticated route');
    }
    return request.user;
  },
);
