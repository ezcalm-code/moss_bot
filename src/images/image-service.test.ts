import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ImageService } from './service';
import { createGenerateImageTool } from './image-tool';
import { ZhipuHttpError } from './zhipu';
import type { ImageProvider, ImageSender } from './types';

const log = pino({ level: 'silent' });

function makeService(provider: ImageProvider, cooldownMinutes = 10) {
  const sent: { chatId: string; url: string }[] = [];
  let senderFn: ImageSender | undefined = async (chatId, image) => {
    sent.push({ chatId, url: image.url });
  };
  const svc = new ImageService(provider, cooldownMinutes, log);
  svc.registerSender('telegram', async (chatId, image) => {
    if (!senderFn) throw new Error('sender removed');
    await senderFn(chatId, image);
  });
  return {
    svc,
    sent,
    removeSender: () => {
      senderFn = undefined;
    },
  };
}

const OK_PROVIDER: ImageProvider = {
  id: 'fake',
  async generate() {
    return { url: 'https://img.example/a.png' };
  },
};

const ctxBase = {
  platform: 'telegram',
  chatId: 'c1',
  senderId: 'u1',
  senderName: 'U1',
  isGroup: false,
  turnId: 't0',
  log,
} as const;

describe('ImageService', () => {
  it('生成成功 → sender 收到 url → 返回成功文案', async () => {
    const { svc, sent } = makeService(OK_PROVIDER);
    const out = await svc.generateAndSend('telegram', 'c1', '戴墨镜的猫', 't1');
    expect(sent).toEqual([{ chatId: 'c1', url: 'https://img.example/a.png' }]);
    expect(out).toContain('图片已生成并发送');
  });

  it('冷却期内不再生成（同轮也冷却），不调 sender', async () => {
    const { svc, sent } = makeService(OK_PROVIDER);
    await svc.generateAndSend('telegram', 'c1', '第一张', 't1');
    const out = await svc.generateAndSend('telegram', 'c1', '第二张', 't2');
    expect(out).toContain('冷却');
    expect(sent).toHaveLength(1);
  });

  it('provider 抛错转失败说明（不抛出）', async () => {
    const bad: ImageProvider = {
      id: 'bad',
      async generate() {
        throw new ZhipuHttpError(429, 'rate limited');
      },
    };
    const { svc, sent } = makeService(bad);
    const out = await svc.generateAndSend('telegram', 'c1', '画', 't1');
    expect(out).toContain('generate_image 执行失败');
    expect(out).toContain('rate limited');
    expect(sent).toHaveLength(0);
  });

  it('无 sender（REPL）返回不支持', async () => {
    // 不经 makeService：全新 service 未注册任何 sender（REPL 场景）
    const svc = new ImageService(OK_PROVIDER, 10, log);
    const out = await svc.generateAndSend('telegram', 'c1', '画', 't1');
    expect(out).toContain('当前平台不支持发图');
  });

  it('createGenerateImageTool 缺 prompt 返回参数错误', async () => {
    const { svc } = makeService(OK_PROVIDER);
    const tool = createGenerateImageTool({ service: svc });
    expect(await tool.exec({}, ctxBase)).toContain('参数错误');
  });
});

describe('generate_image via tool（sender 失败冒泡为失败说明）', () => {
  it('sender 抛错 → 失败说明串', async () => {
    const { svc, removeSender } = makeService(OK_PROVIDER);
    removeSender(); // senderFn undefined → 调用抛 'sender removed'
    const tool = createGenerateImageTool({ service: svc });
    const out = await tool.exec({ prompt: '猫' }, { ...ctxBase, turnId: 't9' });
    expect(out).toContain('generate_image 执行失败');
  });
});
