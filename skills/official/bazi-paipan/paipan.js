#!/usr/bin/env node

/**
 * 八字排盘脚本（基于 bazi-ts-lib，本地计算）
 *
 * stdin:  JSON { solarDate, hour, minute?, gender, zishiMode?, childLimitMode?, include? }
 * stdout: JSON 八字排盘结果
 */

import {
  getAnnualFortuneRange,
  getBaZi,
  getBaZiBySiZhu,
  getFortune,
  getPattern,
} from 'bazi-ts-lib';
import { solarToLunar } from 'iching-shifa';

const SECTIONS = ['bazi', 'fortune', 'pattern'];
const DEFAULT_DECADE_COUNT = 11;

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  }
  return JSON.parse(text);
}

function normalizeGender(g) {
  if (g === 'male') return '男';
  if (g === 'female') return '女';
  if (g === '男' || g === '女') return g;
  throw new Error(`非法 gender: ${g}`);
}

function buildBirthDate(solarDate, hour, minute) {
  const [y, m, d] = solarDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`非法 solarDate: ${solarDate}`);
  return new Date(y, m - 1, d, hour, minute, 0);
}

function buildFortuneSection(bazi, fortuneSource, birthDate, config) {
  const birthYear = birthDate.getFullYear();
  const currentAnnualYear = fortuneSource.currentAnnual?.year ?? birthYear;
  const lastDecadeEndYear =
    fortuneSource.decades.at(-1)?.endYear ?? currentAnnualYear;

  // 流年必须全量返回，避免只给窗口时让下游误判年份范围或遗漏上下文。
  const annuals = getAnnualFortuneRange(
    bazi,
    birthDate,
    birthYear,
    lastDecadeEndYear,
    config,
  );

  const fortune = {
    childLimit: fortuneSource.childLimit,
    decades: fortuneSource.decades,
    annuals,
    annualStartYear: birthYear,
    annualEndYear: lastDecadeEndYear,
    currentAnnualYear,
  };

  return fortune;
}

function buildChildhoodFortune(birthDate) {
  const birthYear = birthDate.getFullYear();
  return {
    index: -1,
    sixtyCycle: '',
    heavenStem: '',
    earthBranch: '',
    sound: '',
    startAge: 1,
    endAge: undefined,
    startYear: birthYear,
    endYear: undefined,
    tenStar: '',
    terrain: '',
    element: '',
    label: '小运',
  };
}

function withReferenceDecadeShape(fortune, birthDate) {
  const firstDecade = fortune.decades[0];
  if (!firstDecade) return fortune;

  const childhood = {
    ...buildChildhoodFortune(birthDate),
    endAge: firstDecade.startAge - 1,
    endYear: firstDecade.startYear - 1,
  };

  return {
    ...fortune,
    childhood,
    decades: [childhood, ...fortune.decades],
  };
}

function getReferenceYearPillar(birthDate) {
  return solarToLunar(
    birthDate.getFullYear(),
    birthDate.getMonth() + 1,
    birthDate.getDate(),
    birthDate.getHours(),
  ).yearGanZhi.gz;
}

function withReferenceYearPillar(bazi, birthDate, gender, config) {
  const referenceYearPillar = getReferenceYearPillar(birthDate);
  if (bazi.pillars.year.sixtyCycle === referenceYearPillar) return bazi;

  const referenceBazi = getBaZiBySiZhu(
    referenceYearPillar,
    bazi.pillars.month.sixtyCycle,
    bazi.pillars.day.sixtyCycle,
    bazi.pillars.hour.sixtyCycle,
    gender,
    config,
  );
  return {
    ...referenceBazi,
    birthTime: bazi.birthTime,
  };
}

export async function runPaipan(input) {
  const {
    solarDate,
    hour,
    minute = 0,
    gender,
    zishiMode = 'early',
    childLimitMode = 'default',
    decadeCount = DEFAULT_DECADE_COUNT,
    include,
  } = input;

  if (!solarDate || hour === undefined || !gender) {
    throw new Error('缺少必填参数: solarDate, hour, gender');
  }

  const sections = include ?? SECTIONS;
  const invalid = sections.filter((s) => !SECTIONS.includes(s));
  if (invalid.length) throw new Error(`非法 include: ${invalid.join(',')}`);

  const birthDate = buildBirthDate(solarDate, hour, minute);
  const config = { zishiMode, childLimitMode, decadeCount };
  const normalizedGender = normalizeGender(gender);
  const bazi = withReferenceYearPillar(
    getBaZi(birthDate, normalizedGender, config),
    birthDate,
    normalizedGender,
    config,
  );

  const result = {};
  for (const section of sections) {
    if (section === 'bazi') {
      result.bazi = bazi;
      continue;
    }
    if (section === 'fortune') {
      const fortune = getFortune(bazi, birthDate, config);
      result.fortune = withReferenceDecadeShape(
        buildFortuneSection(bazi, fortune, birthDate, config),
        birthDate,
      );
      continue;
    }
    if (section === 'pattern') {
      result.pattern = getPattern(bazi);
      continue;
    }
  }

  return result;
}

async function mainFromCli() {
  const input = await readStdin();
  const result = await runPaipan(input);
  console.log(JSON.stringify(result));
}

function isDirectRun() {
  // 浏览器/移动端 import 时没有 process；这里只让 Node CLI 兼容旧后端脚本执行方式。
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return new URL(import.meta.url).pathname === process.argv[1];
}

if (isDirectRun()) {
  mainFromCli().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}
