import {
  Controller,
  Get,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Connection } from 'mongoose';

@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Liveness: the process is up. Used by the container/ALB health check. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable. */
  @Get('ready')
  async ready() {
    try {
      await this.connection.db!.admin().ping();
    } catch {
      throw new ServiceUnavailableException('MongoDB is not reachable');
    }
    return { status: 'ok', checks: { mongo: 'up' } };
  }
}
