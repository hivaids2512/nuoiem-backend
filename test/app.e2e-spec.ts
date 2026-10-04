import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ProblemDetailsFilter } from '../src/common/filters/problem-details.filter.js';
import { HealthController } from '../src/health/health.controller.js';

describe('Health (e2e)', () => {
  let app: INestApplication;
  const ping = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        {
          provide: getConnectionToken(),
          useValue: { db: { admin: () => ({ ping }) } },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health/live', () =>
    request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' }));

  it('GET /health/ready returns 200 when mongo is up', async () => {
    ping.mockResolvedValue({ ok: 1 });
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('GET /health/ready returns a problem document when mongo is down', async () => {
    ping.mockRejectedValue(new Error('down'));
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 503, title: 'MongoDB is not reachable' });
  });
});
