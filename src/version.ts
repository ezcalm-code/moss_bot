import { readFileSync } from 'node:fs';

/** 版本唯一来源是 package.json，避免发版时手动改字符串漂移（v2.0.0 就漏过一次） */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION = pkg.version;
