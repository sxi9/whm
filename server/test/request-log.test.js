import { describe, it, expect } from 'vitest';
import { requestLogLevel, requestLogMessage, requestLogObject } from '../src/lib/request-log.js';
import { skipsAccessLog } from '../src/app.js';

const synthetic = (status) => new Error(`failed with status code ${status}`);

describe('access-log levels', () => {
  it('keeps real failures at error and expected outcomes below it', () => {
    expect(requestLogLevel({ statusCode: 200 })).toBe('info');
    expect(requestLogLevel({ statusCode: 202 })).toBe('info');
    expect(requestLogLevel({ statusCode: 400 })).toBe('info');
    expect(requestLogLevel({ statusCode: 404 })).toBe('info');
    expect(requestLogLevel({ statusCode: 409 })).toBe('info');
    expect(requestLogLevel({ statusCode: 413 })).toBe('info');
    expect(requestLogLevel({ statusCode: 422 })).toBe('info');
    expect(requestLogLevel({ statusCode: 401 })).toBe('warn');
    expect(requestLogLevel({ statusCode: 403 })).toBe('warn');
    expect(requestLogLevel({ statusCode: 429 })).toBe('warn');
    expect(requestLogLevel({ statusCode: 501 })).toBe('warn');
    expect(requestLogLevel({ statusCode: 500 })).toBe('error');
    expect(requestLogLevel({ statusCode: 503 })).toBe('error');
    expect(requestLogLevel({ statusCode: 200 }, new Error('socket hang up'))).toBe('error');
    expect(requestLogLevel({ statusCode: 501 }, new Error('socket hang up'))).toBe('error');
  });

  it('drops the synthetic pino-http error for 501 and names the outcome', () => {
    expect(requestLogMessage({ statusCode: 501 }, synthetic(501))).toBe('request completed (capability missing)');
    expect(requestLogMessage({ statusCode: 500 }, synthetic(500))).toBe('request errored');
    const obj = { res: { statusCode: 501 }, err: synthetic(501), responseTime: 2 };
    expect(requestLogObject({ statusCode: 501 }, obj.err, obj)).toEqual({ res: obj.res, responseTime: 2 });
    expect(requestLogObject({ statusCode: 500 }, synthetic(500), { ...obj, err: synthetic(500) })).toHaveProperty('err');
  });

  it('keeps job SSE streams, system and panel, out of the access log', () => {
    expect(skipsAccessLog({ originalUrl: '/api/system/jobs/42/stream' })).toBe(true);
    expect(skipsAccessLog({ originalUrl: '/api/panel/databases/jobs/42/stream' })).toBe(true);
    expect(skipsAccessLog({ originalUrl: '/api/panel/files/jobs/a1b2/stream?since=0' })).toBe(true);
    expect(skipsAccessLog({ originalUrl: '/api/system/jobs/42' })).toBe(false);
    expect(skipsAccessLog({ originalUrl: '/api/panel/files/jobs/42/stream/extra' })).toBe(false);
    expect(skipsAccessLog({ originalUrl: '/api/panel/files/list?x=/jobs/1/stream' })).toBe(false);
    expect(skipsAccessLog({ originalUrl: '/api/accounts?x=/stream' })).toBe(false);
  });

  it('keeps a real transport error on a 501 response', () => {
    const real = new Error('socket hang up');
    const obj = { res: { statusCode: 501 }, err: real, responseTime: 2 };
    expect(requestLogObject({ statusCode: 501 }, real, obj)).toBe(obj);
    expect(requestLogMessage({ statusCode: 501 }, real)).toBe('request errored');
  });
});
