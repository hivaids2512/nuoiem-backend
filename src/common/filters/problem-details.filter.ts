import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface FieldError {
  field: string;
  message: string;
}

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  422: 'VALIDATION_ERROR',
  429: 'TOO_MANY_REQUESTS',
};

/** Renders every error as an RFC 7807-style problem document with the request id. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let title = isHttp ? exception.message : 'Internal Server Error';
    let errors: FieldError[] | undefined;

    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const message = (body as { message?: unknown }).message;
        if (Array.isArray(message)) {
          // class-validator output: validation failures are reported as 422.
          errors = message.map((m) => toFieldError(String(m)));
          title = 'Validation failed';
        } else if (typeof message === 'string') {
          title = message;
        }
      }
    }

    const finalStatus =
      errors && status === HttpStatus.BAD_REQUEST
        ? HttpStatus.UNPROCESSABLE_ENTITY
        : status;

    if (finalStatus >= 500) {
      this.logger.error(
        { err: exception, requestId: req.id },
        'Unhandled exception',
      );
    }

    res.status(finalStatus).json({
      type: 'about:blank',
      title,
      status: finalStatus,
      code: CODES[finalStatus] ?? (finalStatus >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
      ...(errors && { errors }),
      requestId: req.id,
    });
  }
}

function toFieldError(message: string): FieldError {
  // class-validator messages start with the property name.
  const [field] = message.split(' ');
  return { field: field ?? '', message };
}
