import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter.js';

function run(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host: any = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1' }),
      getResponse: () => ({ status }),
    }),
  };
  new ProblemDetailsFilter().catch(exception, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('ProblemDetailsFilter', () => {
  it('maps HttpExceptions and includes requestId', () => {
    const { status, body } = run(new NotFoundException('Baby not found'));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Baby not found',
      requestId: 'req-1',
    });
  });

  it('turns class-validator failures into 422 with field errors', () => {
    const { status, body } = run(
      new BadRequestException(['volumeMl must be a number']),
    );
    expect(status).toBe(422);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([
      { field: 'volumeMl', message: 'volumeMl must be a number' },
    ]);
  });

  it('hides internals of unknown errors', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body.title).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
