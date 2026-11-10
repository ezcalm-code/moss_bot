export interface GeneratedImage {
  /** 生成图的公开直链（有厂商时效，须立即投递给平台） */
  url: string;
}

/** 文生图 provider 可插拔接口；当前仅智谱 CogView 实现，GPT/Gemini/Grok/Qwen 按需加 */
export interface ImageProvider {
  readonly id: string;
  generate(prompt: string, opts?: { signal?: AbortSignal }): Promise<GeneratedImage>;
}

/** 生成图投递通道：各平台装配后注册（TG sendPhoto 直链；飞书下载转传 image_key） */
export type ImageSender = (chatId: string, image: GeneratedImage) => Promise<void>;
