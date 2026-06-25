'use client';

import { useEffect, useMemo, useState } from 'react';
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

export function useSkillMarket(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [bundles, setBundles] = useState<MarketBundle[]>([]);
  const [skills, setSkills] = useState<MarketSkill[]>([]);
  const [search, setSearch] = useState('');
  // 选中的用途分类，空串表示「全部」；分类只作用于技能区（bundle 不分类）。
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      skillsApi.marketBundles({ limit: 20 }),
      skillsApi.market({ limit: 50 }),
    ])
      .then(([bundleData, skillData]) => {
        setBundles(
          sortBundlesForMarket(Array.isArray(bundleData) ? bundleData : []),
        );
        setSkills(sortSkillsByHeat(Array.isArray(skillData) ? skillData : []));
      })
      .catch((err) => {
        setBundles([]);
        setSkills([]);
        notify(
          'error',
          err instanceof Error ? err.message : '加载技能市场失败',
        );
      })
      .finally(() => setLoading(false));
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
