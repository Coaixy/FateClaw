/**
 * FateClaw iLink API Client
 *
 * Implements the Tencent iLink Bot Protocol for WeChat messaging.
 * API base: https://ilinkai.weixin.qq.com
 *
 * References:
 *   - openclaw-weixin/src/api.ts (reference implementation)
 *   - openclaw-weixin/weixin-bot-api.md (protocol documentation)
 */

import crypto from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { logger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
}

export interface ImageItem {
  aeskey?: string;
  url?: string;
}

export interface VoiceItem {
  text?: string;
  playtime?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

// ─── HTTP Layer ──────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 38_000,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: '1.0.2' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      // Timeout — return empty response for long-poll
      return { ret: 0, msgs: [] } as unknown as T;
    }
    throw err;
  }
}

// ─── QR Code Login ───────────────────────────────────────────────────────

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrCodeStatusResponse {
  status: 'wait' | 'scaned' | 'expired' | 'confirmed';
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

export interface ScanLoginResult {
  bot_token: string;
  base_url: string;
  account_id: string;
  user_id: string;
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';

/** GET 请求（用于扫码登录这类不需要 token 的公开接口） */
async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** 渲染二维码到终端 */
async function renderQR(url: string): Promise<void> {
  // 始终打印 URL，方便复制到浏览器打开
  console.log('\n  二维码图片链接（复制到浏览器打开）：', url, '\n');

  // 优先尝试 imgcat（macOS iTerm）
  try {
    const { default: QRCode } = await import('qrcode');
    const tmp = join(tmpdir(), `weixin-qr-${Date.now()}.png`);
    await QRCode.toFile(tmp, url, { width: 360, margin: 2 });
    const result = spawnSync(
      '/Applications/iTerm.app/Contents/Resources/utilities/imgcat',
      [tmp],
      { stdio: ['ignore', 'inherit', 'ignore'] },
    );
    fs.unlinkSync(tmp);
    if (result.status === 0) {
      console.log();
      return;
    }
  } catch (_) {
    // imgcat 不可用，降级到下一个渲染器
  }

  // 降级：qrcode-terminal
  try {
    const { default: qrterm } = await import('qrcode-terminal');
    await new Promise<void>((resolve) => {
      qrterm.generate(url, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
    return;
  } catch (_) {
    // qrcode-terminal 不可用，降级到下一个渲染器
  }

  // 最降级：直接打印 URL
  console.log('\n  二维码图片链接：', url, '\n');
}

/**
 * 获取 iLink 扫码二维码（API 友好版）。
 */
export async function getLoginQrCode(): Promise<QrCodeResponse> {
  return apiGet<QrCodeResponse>(
    DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
  );
}

/**
 * 查询二维码扫码状态（API 友好版）。
 */
export async function getQrCodeStatus(
  qrcode: string,
): Promise<QrCodeStatusResponse> {
  return apiGet<QrCodeStatusResponse>(
    DEFAULT_BASE_URL,
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
  );
}

/**
 * 扫码登录 iLink Bot（CLI 版）。
 * 调用方负责创建账号并存入数据库。
 */
export async function scanLogin(): Promise<ScanLoginResult> {
  console.log('\n🔐 开始微信扫码登录...\n');

  const qrResp = await apiGet<QrCodeResponse>(
    DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
  );
  let currentQrcode = qrResp.qrcode;
  let currentQrcodeUrl = qrResp.qrcode_img_content;

  console.log('📱 请用微信扫描以下二维码：\n');
  await renderQR(currentQrcodeUrl);

  console.log('⏳ 等待扫码...');
  const deadline = Date.now() + 5 * 60_000;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    const statusResp = await apiGet<QrCodeStatusResponse>(
      DEFAULT_BASE_URL,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
    );

    switch (statusResp.status) {
      case 'wait':
        process.stdout.write('.');
        break;

      case 'scaned':
        process.stdout.write('\n👀 已扫码，请在微信端确认...\n');
        break;

      case 'expired': {
        if (++refreshCount > 3) {
          throw new Error('二维码多次过期，请重新运行');
        }
        console.log(`\n⏳ 二维码过期，刷新中 (${refreshCount}/3)...`);
        const newQr = await apiGet<QrCodeResponse>(
          DEFAULT_BASE_URL,
          `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
        );
        currentQrcode = newQr.qrcode;
        currentQrcodeUrl = newQr.qrcode_img_content;
        console.log('  新二维码 URL:', currentQrcodeUrl);
        await renderQR(currentQrcodeUrl);
        break;
      }

      case 'confirmed': {
        console.log('\n✅ 登录成功！\n');
        return {
          bot_token: statusResp.bot_token!,
          base_url: statusResp.baseurl || DEFAULT_BASE_URL,
          account_id: statusResp.ilink_bot_id!,
          user_id: statusResp.ilink_user_id!,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('登录超时');
}

// ─── Message Chunking ───────────────────────────────────────────────────

const MAX_CHUNK_SIZE = 3600;
// iLink 单请求允许最多 10 条出站消息。给单次 sendMessage 放宽到 6 片
// （约 21600 字符），仍为后续 send_message 留 3-4 条配额。
const MAX_CHUNKS = 6;
const CHUNK_SEND_DELAY_MS = 300;

/**
 * 将长文本按自然断点分片，每片不超过 maxLen 字符。
 * 优先按双换行（段落）→ 单换行 → 句号/问号/感叹号 → 逗号 → 硬切。
 */
function splitTextIntoChunks(text: string, maxLen = MAX_CHUNK_SIZE): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cutIndex = -1;

    // 在 maxLen 范围内从后往前找最佳断点
    const segment = remaining.slice(0, maxLen);

    // 1. 双换行（段落边界）
    cutIndex = segment.lastIndexOf('\n\n');
    if (cutIndex > maxLen * 0.3) {
      chunks.push(remaining.slice(0, cutIndex).trimEnd());
      remaining = remaining.slice(cutIndex + 2).trimStart();
      continue;
    }

    // 2. 单换行
    cutIndex = segment.lastIndexOf('\n');
    if (cutIndex > maxLen * 0.3) {
      chunks.push(remaining.slice(0, cutIndex).trimEnd());
      remaining = remaining.slice(cutIndex + 1).trimStart();
      continue;
    }

    // 3. 句末标点（中英文句号、问号、感叹号）
    const sentenceEnd = segment.search(/[。！？.!?][^。！？.!?]*$/);
    if (sentenceEnd > maxLen * 0.3) {
      cutIndex = sentenceEnd + 1;
      chunks.push(remaining.slice(0, cutIndex).trimEnd());
      remaining = remaining.slice(cutIndex).trimStart();
      continue;
    }

    // 4. 逗号（中英文）
    const commaEnd = segment.search(/[，,][^，,]*$/);
    if (commaEnd > maxLen * 0.3) {
      cutIndex = commaEnd + 1;
      chunks.push(remaining.slice(0, cutIndex).trimEnd());
      remaining = remaining.slice(cutIndex).trimStart();
      continue;
    }

    // 5. 硬切
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  // 限制分片数量，超出部分截断。放宽到 6 片后这里极少触发，
  // 打一条 warn 便于运维观测是否还有被截断的长回复。
  if (chunks.length > MAX_CHUNKS) {
    logger.warn(
      {
        textLength: text.length,
        chunkCount: chunks.length,
        maxChunks: MAX_CHUNKS,
      },
      'ilink.splitTextIntoChunks: 内容超出分片上限，尾部已截断',
    );
    const truncated = chunks.slice(0, MAX_CHUNKS);
    truncated[MAX_CHUNKS - 1] += '\n\n…（内容过长，已截断）';
    return truncated;
  }

  return chunks;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface IlinkAccount {
  id: string;
  bot_token: string;
  base_url: string;
}

/**
 * Long-poll for new messages from iLink API.
 * Server holds connection up to ~35s until new messages arrive.
 *
 * @param account  - iLink account credentials
 * @param buf      - get_updates_buf cursor from previous call (empty string for first call)
 * @returns        - messages + new cursor
 */
export async function getUpdates(
  account: IlinkAccount,
  buf: string,
): Promise<GetUpdatesResp> {
  const resp = await apiPost<GetUpdatesResp>(
    account.base_url,
    'ilink/bot/getupdates',
    { get_updates_buf: buf || '' },
    account.bot_token,
    38_000,
  );
  return resp;
}

/**
 * Send a text message via iLink API.
 * Long messages are automatically split into chunks at natural boundaries.
 * Must include context_token from the received message to thread replies.
 *
 * @param account      - iLink account credentials
 * @param toUserId     - recipient user ID
 * @param text         - message text
 * @param contextToken - context_token from received message (required for threading)
 * @returns client_id  - last chunk's message client ID for tracking
 */
export async function sendMessage(
  account: IlinkAccount,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<string> {
  const chunks = splitTextIntoChunks(text);
  let lastClientId = '';

  for (let i = 0; i < chunks.length; i++) {
    const clientId = `fateclaw-${crypto.randomUUID()}`;

    if (i > 0) {
      await new Promise((r) => setTimeout(r, CHUNK_SEND_DELAY_MS));
    }

    await apiPost(
      account.base_url,
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: contextToken,
          item_list: [
            { type: MessageItemType.TEXT, text_item: { text: chunks[i] } },
          ],
        },
      },
      account.bot_token,
      15_000,
    );

    lastClientId = clientId;
  }

  if (chunks.length > 1) {
    logger.info(
      { chunks: chunks.length, totalLen: text.length },
      '长消息已分片发送',
    );
  }

  return lastClientId;
}

/**
 * Convert iLink WeixinMessage to FateClaw NewMessage format.
 * Extracts text content from item_list.
 */
export function parseWeixinMessage(
  msg: WeixinMessage,
  _accountId: string,
): { content: string; sender: string; sender_name: string } | null {
  const itemList = msg.item_list ?? [];
  let content = '';
  const sender = msg.from_user_id ?? '';
  const senderName = sender;

  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      content = item.text_item.text;
      break;
    }
    // TODO: handle other media types
  }

  if (!content && itemList.length > 0) {
    // Non-text message — skip for now (could extend later)
    logger.debug(
      { msg_id: msg.message_id, type: itemList[0].type },
      '跳过非文本消息',
    );
    return null;
  }

  return {
    content,
    sender,
    sender_name: senderName,
  };
}
