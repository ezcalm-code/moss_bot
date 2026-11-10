import { ConfigError } from '../config/load';
import type { ResolvedConfig } from '../config/schema';
import type { Dispatcher } from 'undici';
import { createZhipuImageProvider } from './zhipu';
import type { ImageProvider } from './types';

export type { ImageProvider, GeneratedImage } from './types';

const IMAGE_PROVIDER_FACTORIES: Record<
  string,
  (opts: { apiKey: string; dispatcher?: Dispatcher }) => ImageProvider
> = {
  zhipu: createZhipuImageProvider,
};

/** 按配置解析生图 provider；未启用返回 undefined；未知 provider / 缺 key 抛 ConfigError */
export function createImageProvider(
  config: ResolvedConfig['imageGeneration'],
  proxyDispatcher?: Dispatcher,
): ImageProvider | undefined {
  if (!config.enabled) return undefined;
  const factory = IMAGE_PROVIDER_FACTORIES[config.provider];
  if (!factory) {
    throw new ConfigError(
      `未知的 imageGeneration.provider: "${config.provider}"（当前支持: ${Object.keys(IMAGE_PROVIDER_FACTORIES).join(', ')}）`,
    );
  }
  if (!config.apiKey) {
    throw new ConfigError(
      `imageGeneration 已启用但缺少 API key：请设置环境变量 ${config.apiKeyEnv}`,
    );
  }
  return factory({ apiKey: config.apiKey, dispatcher: proxyDispatcher });
}
