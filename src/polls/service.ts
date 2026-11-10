import { randomUUID } from 'node:crypto';
import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';

interface PollState {
  question: string;
  options: string[];
  /** voterId → optionIdx（改票覆盖） */
  votes: Map<string, number>;
}

export type SendPollFn = (
  chatId: string,
  pollId: string,
  question: string,
  options: string[],
) => Promise<void>;

export interface VoteResult {
  ok: boolean;
  /** 给 toast 的简短反馈（含当前票数） */
  toast: string;
}

/**
 * 群投票状态与卡片构造。TG 用原生 poll（客户端自渲染，不占这里的状态）；
 * 飞书走交互卡片按钮回调，票存内存（重启丢失可接受，轻量场景）。
 */
export class PollsService {
  private readonly polls = new Map<string, PollState>();
  private readonly senders = new Map<PlatformId, SendPollFn>();

  constructor(private readonly log: Logger) {}

  /** 装配点在各适配器就绪后注册发送通道 */
  registerSender(platform: PlatformId, send: SendPollFn): void {
    this.senders.set(platform, send);
  }

  hasSender(platform: PlatformId): boolean {
    return this.senders.has(platform);
  }

  async createPoll(
    platform: PlatformId,
    chatId: string,
    question: string,
    options: string[],
  ): Promise<string> {
    const send = this.senders.get(platform);
    if (!send) throw new Error('当前平台不支持投票');
    const pollId = randomUUID().slice(0, 8);
    if (platform === 'feishu') {
      this.polls.set(pollId, { question, options, votes: new Map() });
    }
    await send(chatId, pollId, question, options);
    return pollId;
  }

  /** 飞书卡片回调投票；voterId 用 open_id，改票覆盖 */
  vote(pollId: string, voterId: string, optionIdx: number): VoteResult {
    const poll = this.polls.get(pollId);
    if (!poll || optionIdx < 0 || optionIdx >= poll.options.length) {
      return { ok: false, toast: '投票已失效（可能 bot 重启过），请重新发起' };
    }
    poll.votes.set(voterId, optionIdx);
    const tally = poll.options.map(
      (opt, i) => `${opt}：${[...poll.votes.values()].filter((v) => v === i).length} 票`,
    );
    this.log.info({ pollId, voterId, optionIdx }, 'feishu 投票记录');
    return { ok: true, toast: `已投「${poll.options[optionIdx]}」｜${tally.join(' ')}` };
  }
}

/** 飞书投票卡片 JSON（schema 2.0；按钮走 behaviors.callback，value 随回调原样返回） */
export function buildPollCardJson(question: string, options: string[], pollId: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `🗳 ${question}` } },
    body: {
      elements: options.map((opt, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt },
        type: 'default',
        behaviors: [{ type: 'callback', value: { type: 'poll_vote', poll_id: pollId, option_idx: i } }],
      })),
    },
  });
}
