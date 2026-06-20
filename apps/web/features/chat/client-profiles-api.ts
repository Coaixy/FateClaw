import type {
  ClientProfileDto,
  ClientProfileListResponseDto,
  ClientProfileUpsertDto,
  ClientStatusDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type ClientProfile = ClientProfileDto;
export type ClientProfileUpsert = ClientProfileUpsertDto;
export type ClientProfileListResponse = ClientProfileListResponseDto;
export type ClientStatus = ClientStatusDto;

const pathSegment = (value: string) => encodeURIComponent(value);

/**
 * 客户（被算者）档案的浏览器侧 REST 封装。
 *
 * 与后端 `/api/client-profiles` 约定对接，统一走 `requestJson` 处理鉴权与错误。
 */
export const clientProfilesApi = {
  /** 拉取当前卦师的全部客户档案。 */
  list: () =>
    requestJson<ClientProfileListResponse>('/api/client-profiles'),
  /** 读取单个客户档案详情。 */
  get: (id: string) =>
    requestJson<ClientProfile>(`/api/client-profiles/${pathSegment(id)}`),
  /** 新建客户档案，返回创建后的完整记录。 */
  create: (data: ClientProfileUpsert) =>
    requestJson<ClientProfile>('/api/client-profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 更新指定客户档案，返回更新后的完整记录。 */
  update: (id: string, data: ClientProfileUpsert) =>
    requestJson<ClientProfile>(`/api/client-profiles/${pathSegment(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  /** 删除指定客户档案。 */
  delete: (id: string) =>
    requestJson<SuccessResponse>(`/api/client-profiles/${pathSegment(id)}`, {
      method: 'DELETE',
    }),
};
