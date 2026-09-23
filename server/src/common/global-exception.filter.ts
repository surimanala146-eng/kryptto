import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Response } from 'express';
import { ApiError } from './api-error';

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorEnvelope = {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    };

    if (exception instanceof ApiError) {
      status = exception.status;
      body = exception.details
        ? {
            error: {
              code: exception.code,
              message: exception.message,
              details: exception.details,
            },
          }
        : { error: { code: exception.code, message: exception.message } };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        body = { error: { code: exception.name.toUpperCase(), message: payload } };
      } else if (payload && typeof payload === 'object' && 'message' in payload) {
        const raw = payload as { message: string | string[]; error?: string | { message?: string } };
        const message = Array.isArray(raw.message) ? raw.message.join('; ') : raw.message;
        const inner = typeof raw.error === 'object' && raw.error?.message ? raw.error.message : null;
        body = {
          error: {
            code: HttpStatus[status] ?? 'HTTP_ERROR',
            message: inner ?? message ?? exception.message,
          },
        };
        if (Array.isArray(raw.message)) {
          body.error.details = { messages: raw.message };
        }
      } else {
        body = { error: { code: 'HTTP_ERROR', message: exception.message } };
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.stack ?? `${exception.name}: ${exception.message}`);
      body = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } };
    }

    if (status >= 500 && !(exception instanceof ApiError)) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }

    if (response && typeof response.status === 'function') {
      response.status(status).json(body);
    }
  }
}
