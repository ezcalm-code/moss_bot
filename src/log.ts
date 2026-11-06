import pino from 'pino';
import type { LogLevel } from './config/schema';

export type Logger = pino.Logger;

export function createLogger(level: LogLevel): Logger {
  const isProd = process.env.NODE_ENV === 'production';
  return pino({
    level,
    transport: isProd
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  });
}
