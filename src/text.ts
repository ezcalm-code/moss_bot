export const texts = {
  welcome: (name: string) => `你好，我是 ${name}。直接发消息就能聊，发送 /help 查看可用命令。`,
  helpHeader: '可用命令：',
  unknownCommand: (name: string) => `未知的命令 /${name}，发送 /help 查看可用命令。`,
  unsupportedAttachment: '暂时只支持文字消息和图片，语音/文件等能力还在路上。',
  noVision: (available: string[]) =>
    `当前模型可能不支持看图片。可用 /model 切换到支持视觉的模型后再发图（可用模型: ${available.join(', ')}）。`,
  currentModel: (alias: string) => `当前模型: ${alias}`,
  modelSwitched: (alias: string) => `已切换模型: ${alias}`,
  unknownModel: (alias: string, available: string[]) =>
    `未知模型 "${alias}"。可用模型: ${available.join(', ')}`,
  reset: '已清空当前会话的对话历史。',
  internalError: '出了点问题，请稍后再试。',
  /** 被 @ / 回复但剥掉 @ 后没有内容：回一句轻量搭话，避免装死 */
  emptyMention: '在的在的——想说什么直接说～',
};
