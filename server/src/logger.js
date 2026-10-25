import pino from 'pino';

export function createLogger(level = 'info', env = 'development') {
  const pretty = env !== 'production' && process.stdout.isTTY;
  return pino({
    level,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token', '*.secret'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  });
}
