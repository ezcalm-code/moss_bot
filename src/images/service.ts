import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';
import { ChatCooldown } from '../tools/cooldown';
import type { GeneratedImage, ImageProvider, ImageSender } from './types';

/**
 * 生图服务：provider 生成 + 平台 sender 投递 + per-chat 冷却（同轮也冷却——
 * 生图比搜索贵一个量级，连画多张烧免费额度）。
 * 生成失败不回滚冷却：请求已到达厂商（免费档也计调用次数），防失败场景反复重试。
 */
export class ImageService {
  private readonly cooldown: ChatCooldown;
  private readonly senders = new Map<PlatformId, ImageSender>();

  constructor(
    private readonly provider: ImageProvider,
    cooldownMinutes: number,
    private readonly log: Logger,
  ) {
    this.cooldown = new ChatCooldown(cooldownMinutes * 60_000);
  }

  registerSender(platform: PlatformId, send: ImageSender): void {
    this.senders.set(platform, send);
  }

  hasSender(platform: PlatformId): boolean {
    return this.senders.has(platform);
  }

  /** 生成并发送到指定会话；返回给模型的结果串（成功/冷却/失败/不支持，模型措辞转述） */
  async generateAndSend(
    platform: PlatformId,
    chatId: string,
    prompt: string,
    turnId: string,
  ): Promise<string> {
    const key = `${platform}:${chatId}`;
    const remainSec = this.cooldown.check(key, turnId);
    if (remainSec !== undefined) {
      this.log.info({ platform, chatId, remainSec }, 'generate_image 冷却命中');
      return `generate_image 处于冷却中：本会话生图间隔 10 分钟，剩余约 ${remainSec} 秒。请告知用户稍后再试。`;
    }
    const send = this.senders.get(platform);
    if (!send) {
      return '当前平台不支持发图。';
    }
    this.cooldown.mark(key, turnId);
    try {
      const image: GeneratedImage = await this.provider.generate(prompt);
      await send(chatId, image);
      this.log.info({ platform, chatId, url: image.url }, 'generate_image 完成');
      return `图片已生成并发送：${prompt}`;
    } catch (err) {
      this.log.warn({ err, chatId, prompt: prompt.slice(0, 50) }, 'generate_image 执行失败');
      return `generate_image 执行失败：${err instanceof Error ? err.message : String(err)}。请告知用户生图暂时不可用。`;
    }
  }
}
