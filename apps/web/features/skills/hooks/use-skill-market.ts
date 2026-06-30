'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';
import { SKILL_CATEGORIES } from '@fateclaw/contracts/skills';

import {
  skillsApi,
  type MarketBundle,
  type MarketSkill,
} from '@/features/skills/api';

/**
 * 捆绑包在市场里优先展示。
 * 当前先按包含技能数倒序，数量相同时再按名称稳定排序，
 * 避免接口返回顺序变化时列表抖动。
 */
function sortBundlesForMarket(bundles: MarketBundle[]): MarketBundle[] {
  return [...bundles].sort((left, right) => {
    if (left.skill_count !== right.skill_count) {
      return right.skill_count - left.skill_count;
    }
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

/**
 * 技能区保留热度榜语义。
 * 当前热度先按订阅人数倒序，订阅相同时再按名称稳定排序，
 * 避免接口返回顺序变化时前端榜单抖动。
 */
function sortSkillsByHeat(skills: MarketSkill[]): MarketSkill[] {
  return [...skills].sort((left, right) => {
    if (left.stat_subscriber_count !== right.stat_subscriber_count) {
      return right.stat_subscriber_count - left.stat_subscriber_count;
    }
    return left.skill_name.localeCompare(right.skill_name, 'zh-CN');
  });
}

/**
 * 技能市场拉取状态：bundles / skills / loading 三者随同一次请求整体翻转，
 * 用 reducer 一次 dispatch 给出完整快照，避免一个 effect 内多次 setState 级联重渲染。
 */
interface MarketFetchState {
  bundles: MarketBundle[];
  skills: MarketSkill[];
  loading: boolean;
}

type MarketFetchAction =
  | { type: 'start' }
  | { type: 'success'; bundles: MarketBundle[]; skills: MarketSkill[] }
  | { type: 'error' };

function marketFetchReducer(
  state: MarketFetchState,
  action: MarketFetchAction,
): MarketFetchState {
  switch (action.type) {
    case 'start':
      return { ...state, loading: true };
    case 'success':
      return { bundles: action.bundles, skills: action.skills, loading: false };
    case 'error':
      return { bundles: [], skills: [], loading: false };
  }
}

export function useSkillMarket(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [{ bundles, skills, loading }, dispatch] = useReducer(
    marketFetchReducer,
    { bundles: [], skills: [], loading: true },
  );
  const [search, setSearch] = useState('');
  // 选中的用途分类，空串表示「全部」；分类只作用于技能区（bundle 不分类）。
  const [category, setCategory] = useState('');

  useEffect(() => {
    dispatch({ type: 'start' });
    Promise.all([
      skillsApi.marketBundles({ limit: 20 }),
      skillsApi.market({ limit: 50 }),
    ])
      .then(([bundleData, skillData]) => {
        dispatch({
          type: 'success',
          bundles: sortBundlesForMarket(
            Array.isArray(bundleData) ? bundleData : [],
          ),
          skills: sortSkillsByHeat(Array.isArray(skillData) ? skillData : []),
        });
      })
      .catch((err) => {
        dispatch({ type: 'error' });
        notify(
          'error',
          err instanceof Error ? err.message : '加载技能市场失败',
        );
      });
  }, [notify]);

  const filteredBundles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return bundles;

    return sortBundlesForMarket(
      bundles.filter(
        (bundle) =>
          bundle.name.toLowerCase().includes(query) ||
          bundle.description.toLowerCase().includes(query),
      ),
    );
  }, [bundles, search]);

  // 当前结果集中实际出现过的门类，按 SKILL_CATEGORIES 规范顺序排列。
  // 只展示有技能的门类，避免出现点了没结果的空筛选项。
  const availableCategories = useMemo(() => {
    const present = new Set(skills.map((skill) => skill.category));
    return SKILL_CATEGORIES.filter((item) => present.has(item));
  }, [skills]);

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = skills.filter((skill) => {
      // 先按门类过滤；category 为空串时不限门类。
      if (category && skill.category !== category) return false;
      if (!query) return true;
      return (
        skill.skill_name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query)
      );
    });
    return sortSkillsByHeat(filtered);
  }, [skills, search, category]);

  return {
    bundles,
    filteredBundles,
    skills,
    filteredSkills,
    search,
    setSearch,
    category,
    setCategory,
    availableCategories,
    loading,
  };
}
