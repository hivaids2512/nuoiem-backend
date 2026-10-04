import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';

const withPing = (ping: () => Promise<unknown>) =>
  new HealthController({ db: { admin: () => ({ ping }) } } as any);

describe('HealthController', () => {
  it('live is ok', () => {
    expect(withPing(async () => ({})).live()).toEqual({ status: 'ok' });
  });

  it('ready is ok when mongo answers', async () => {
    await expect(withPing(async () => ({ ok: 1 })).ready()).resolves.toMatchObject(
      { status: 'ok' },
    );
  });

  it('ready is 503 when mongo is down', async () => {
    const c = withPing(async () => {
      throw new Error('down');
    });
    await expect(c.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
