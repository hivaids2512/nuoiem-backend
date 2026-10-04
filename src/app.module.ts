import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get('NODE_ENV') === 'production';
        return {
          pinoHttp: {
            level: config.get<string>('LOG_LEVEL'),
            genReqId: (req, res) => {
              const id = (req.headers['x-request-id'] as string) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            // Health checks fire every few seconds; keep them out of the logs.
            autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            transport: isProd
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          },
        };
      },
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        // Indexes are created by the migration step in production (see design §7.3).
        autoIndex: config.get('NODE_ENV') !== 'production',
      }),
    }),
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
