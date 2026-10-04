import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService);
  app.useLogger(app.get(Logger));

  // Behind the ALB: trust one proxy hop so req.ip / protocol are correct.
  app.set('trust proxy', 1);
  app.use(helmet());
  // Let ECS stop tasks gracefully on SIGTERM.
  app.enableShutdownHooks();

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const isProd = config.get('NODE_ENV') === 'production';
  if (!isProd || config.get('SWAGGER_ENABLED') === 'true') {
    const doc = new DocumentBuilder()
      .setTitle('Nuoi Em API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  await app.listen(config.getOrThrow<number>('PORT'), '0.0.0.0');
}
void bootstrap();
