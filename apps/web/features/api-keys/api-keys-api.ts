import type {
  ApiKeyCreatedDto,
  ApiKeyDto,
  CreateApiKeyRequest,
  ListApiKeysResponse,
} from '@fateclaw/contracts/api-keys';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type ApiKey = ApiKeyDto;
export type ApiKeyCreated = ApiKeyCreatedDto;

const pathSegment = (value: string) => encodeURIComponent(value);

/**
 * 对外开放 API Key 的浏览器侧 REST 封装。
 *
 * 与后端 `/api/api-keys`（站内 JWT 鉴权）对接，统一走 `requestJson` 处理鉴权与错误。
 * 注意：`create` 的返回体含**明文 key**（`key` 字段），仅此一次可得，调用方需立即展示给用户后丢弃。
 */
export const apiKeysApi = {
  /** 列出当前用户的全部 API Key（脱敏，含已吊销）。 */
  list: () => requestJson<ListApiKeysResponse>('/api/api-keys'),
  /** 生成一个 API Key；响应含一次性明文 `key`。仅会员可调用（否则后端返 403）。 */
  create: (data: CreateApiKeyRequest) =>
    requestJson<ApiKeyCreatedDto>('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 吊销指定 API Key（不可恢复）。 */
  revoke: (id: string) =>
    requestJson<SuccessResponse>(`/api/api-keys/${pathSegment(id)}`, {
      method: 'DELETE',
    }),
};
