'use client';

import { useCallback, useRef, useState } from 'react';

import {
  clientProfilesApi,
  type ClientProfile,
  type ClientProfileUpsert,
} from '@/features/chat/client-profiles-api';

/**
 * 客户档案的前端状态与 CRUD 操作集合。
 *
 * 负责把 `clientProfilesApi` 的结果同步到本地 state，并在出错时通过 `notify` 反馈。
 * 各写操作在成功后会就地更新内存列表，调用方无需手动 reload。
 *
 * @param notify 统一的成功/失败提示回调。
 * @returns `{ profiles, loading, loadProfiles, create, update, remove }`。
 */
export function useClientProfiles(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [profiles, setProfiles] = useState<ClientProfile[]>([]);
  const [loading, setLoading] = useState(false);

  // 用 ref 持有最新的 notify，使 loadProfiles 无需把 notify 列入依赖。
  // 否则调用方若传入内联函数（如 sidebar/归档面板的 `() => {}`），notify 每次渲染都是
  // 新引用，会让 loadProfiles 引用不稳定；而依赖 loadProfiles 的 useEffect 便会反复执行，
  // 无限重复请求 /api/client-profiles（曾导致前端被防火墙限流屏蔽）。
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await clientProfilesApi.list();
      const list = res.clients ?? [];
      setProfiles(list);
      return list;
    } catch (err) {
      notifyRef.current(
        'error',
        err instanceof Error ? err.message : '加载客户档案失败',
      );
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (data: ClientProfileUpsert) => {
      const created = await clientProfilesApi.create(data);
      // 新建客户置顶，方便用户立刻看到刚建的档案。
      setProfiles((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ]);
      return created;
    },
    [],
  );

  const update = useCallback(
    async (id: string, data: ClientProfileUpsert) => {
      const updated = await clientProfilesApi.update(id, data);
      setProfiles((previous) =>
        previous.map((item) => (item.id === id ? updated : item)),
      );
      return updated;
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      await clientProfilesApi.delete(id);
      setProfiles((previous) => previous.filter((item) => item.id !== id));
    },
    [],
  );

  return { profiles, loading, loadProfiles, create, update, remove };
}
