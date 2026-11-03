/**
 * 通道注册表：加一个通道 = 加一条记录 + 一个 adapter。
 * `needs` 里声明的绑定缺失时，HTTP 路由必须返回 404（fail-closed），不能"返回空"。
 */

export type ChannelId = 'ws' | 'http' | 'r2' | 'doh';

export interface ChannelSpec {
  id: ChannelId;
  realtime: boolean;
  /** 单帧上限（字节）。 */
  maxFrame: number;
  /** 需要的绑定/密钥。 */
  needs: readonly string[];
  /** 建议的默认间隔（秒）；实时通道为 0。 */
  intervalSec: number;
  /** UI 上的说明。 */
  note: string;
}

export const CHANNELS: Record<ChannelId, ChannelSpec> = {
  ws: {
    id: 'ws',
    realtime: true,
    maxFrame: 1 << 20,
    needs: ['SESSION'],
    intervalSec: 0,
    note: '主通道。DO + WebSocket hibernation，空闲不计 duration。',
  },
  http: {
    id: 'http',
    realtime: false,
    maxFrame: 1 << 20,
    needs: ['SESSION'],
    intervalSec: 300,
    note: '兜底。WS 被阻断时降级；请求额度随台数线性消耗。',
  },
  r2: {
    id: 'r2',
    realtime: false,
    maxFrame: 8 << 20,
    needs: ['R2'],
    intervalSec: 60,
    note: '死信箱。需要给植入体发 scoped R2 凭据，谨慎使用。',
  },
  doh: {
    id: 'doh',
    realtime: false,
    maxFrame: 200,
    needs: ['CF_DNS_TOKEN'],
    intervalSec: 300,
    note: '仅控制面。借 Cloudflare DNS 写 TXT + 公共 DoH 读，延迟 1–5 分钟。',
  },
};

export const CHANNEL_ORDER: ChannelId[] = ['ws', 'http', 'r2', 'doh'];

export function availableChannels(bindings: Record<string, unknown>): ChannelSpec[] {
  return CHANNEL_ORDER.map((id) => CHANNELS[id]).filter((c) =>
    c.needs.every((n) => bindings[n] !== undefined && bindings[n] !== null && bindings[n] !== ''),
  );
}
