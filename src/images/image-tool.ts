import type { ToolContext, ToolSpec } from '../tools/types';
import type { ImageService } from './service';

export interface GenerateImageToolOptions {
  service: ImageService;
}

/** generate_image 工具：自然语言文生图入口（用户要求画图/画某场景） */
export function createGenerateImageTool(opts: GenerateImageToolOptions): ToolSpec {
  return {
    name: 'generate_image',
    description:
      '生成一张图片并发送到当前会话。当用户明确要求「画 / 生成一张图 / 画一下 XX」时调用；' +
      'prompt 用对画面内容的完整描述（主体、场景、风格），中文即可。' +
      '只是搜索图片或给聊天内容配图时不要调用；写代码、写文档等非画图请求不要调用。' +
      '注意：生图模型对精确文字排版、真实人像还原的能力有限，用户要求超出能力时如实说明。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述：主体 + 场景 + 风格，一句话完整表达' },
      },
      required: ['prompt'],
    },
    async exec(args: unknown, ctx: ToolContext) {
      const prompt = typeof (args as { prompt?: unknown })?.prompt === 'string'
        ? (args as { prompt: string }).prompt.trim()
        : '';
      if (!prompt) {
        return 'generate_image 参数错误：prompt 必须是非空的画面描述。请向用户确认想画什么。';
      }
      return opts.service.generateAndSend(ctx.platform, ctx.chatId, prompt, ctx.turnId);
    },
  };
}
