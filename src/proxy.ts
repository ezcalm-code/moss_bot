import { EnvHttpProxyAgent, type Dispatcher } from 'undici';

let cached: Dispatcher | undefined;
let resolved = false;

/**
 * Node 内置 fetch（undici）不读 HTTP(S)_PROXY 环境变量。
 * 检测到代理环境变量时返回共享 dispatcher，由调用方显式注入
 * （grammY baseFetchConfig / openai fetchOptions）；无代理环境返回 undefined。
 */
export function getProxyDispatcher(): Dispatcher | undefined {
  if (!resolved) {
    resolved = true;
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) {
      cached = new EnvHttpProxyAgent();
    }
  }
  return cached;
}
