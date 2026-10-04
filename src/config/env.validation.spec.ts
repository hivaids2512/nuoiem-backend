import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv({ MONGODB_URI: 'mongodb://localhost/x' });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv({ MONGODB_URI: 'm', PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast when MONGODB_URI is missing', () => {
    expect(() => validateEnv({})).toThrow(/MONGODB_URI/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => validateEnv({ MONGODB_URI: 'm', NODE_ENV: 'prod' })).toThrow(
      /NODE_ENV/,
    );
  });
});
