#!/usr/bin/env node

/**
 * 奇门遁甲排盘脚本（时家拆补法，基于 kinqimen）
 *
 * stdin:  JSON { solarDate?, hour?, minute? }
 * stdout: JSON 时家拆补盘
 */

import { Qimen } from 'kinqimen';
import { solarToLunar, calcXunKong } from 'iching-shifa';
import { isDirectCliRun } from '../_shared/cli-entry.js';

const SHORT_GOD_MAP = {
  值符: '符',
  螣蛇: '蛇',
  腾蛇: '蛇',
  太阴: '阴',
  六合: '合',
  白虎: '虎',
  玄武: '玄',
  九地: '地',
  九天: '天',
};
const GONG_BY_NUMBER = ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'];
const GONG_NUMBER = {
  坎: 1,
  坤: 2,
  震: 3,
  巽: 4,
  中: 5,
  乾: 6,
  兑: 7,
  艮: 8,
  离: 9,
};
const GOD_PAN_YANG = {
  1: ['符', '玄', '阴', '合', '', '天', '地', '蛇', '虎'],
  2: ['合', '符', '玄', '地', '', '阴', '蛇', '虎', '天'],
  3: ['地', '合', '符', '蛇', '', '玄', '虎', '天', '阴'],
  4: ['玄', '阴', '天', '符', '', '虎', '合', '地', '蛇'],
  5: ['合', '符', '玄', '地', '', '阴', '蛇', '虎', '天'],
  6: ['蛇', '地', '合', '虎', '', '符', '天', '阴', '玄'],
  7: ['阴', '天', '虎', '玄', '', '蛇', '符', '合', '地'],
  8: ['天', '虎', '蛇', '阴', '', '地', '玄', '符', '合'],
  9: ['虎', '蛇', '地', '天', '', '合', '阴', '玄', '符'],
};
const GOD_PAN_YIN = {
  1: ['符', '合', '地', '玄', '', '蛇', '阴', '天', '虎'],
  2: ['玄', '符', '合', '阴', '', '地', '天', '虎', '蛇'],
  3: ['阴', '玄', '符', '天', '', '合', '虎', '蛇', '地'],
  4: ['合', '地', '蛇', '符', '', '虎', '玄', '阴', '天'],
  5: ['玄', '符', '合', '阴', '', '地', '天', '虎', '蛇'],
  6: ['天', '阴', '玄', '虎', '', '符', '蛇', '地', '合'],
  7: ['地', '蛇', '虎', '合', '', '天', '符', '玄', '阴'],
  8: ['蛇', '虎', '天', '地', '', '阴', '合', '符', '玄'],
  9: ['虎', '天', '阴', '蛇', '', '玄', '地', '合', '符'],
};

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  }
  text = text.trim();
  return text ? JSON.parse(text) : {};
}

function resolveDateInput(input) {
  if (input.solarDate && input.hour !== undefined) {
    const [y, m, d] = input.solarDate.split('-').map(Number);
    if (!y || !m || !d) throw new Error(`非法 solarDate: ${input.solarDate}`);
    return { year: y, month: m, day: d, hour: input.hour, minute: input.minute ?? 0 };
  }
  if (input.solarDate || input.hour !== undefined) {
    throw new Error('solarDate 和 hour 必须同时传入，或都不传（使用当前时间）');
  }
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  };
}

function buildFourPillarKong(dateInput) {
  const lunar = solarToLunar(
    dateInput.year,
    dateInput.month,
    dateInput.day,
    dateInput.hour,
  );
  return {
    年空: calcXunKong(lunar.yearGanZhi.gz),
    月空: calcXunKong(lunar.monthGanZhi.gz),
    日空: calcXunKong(lunar.dayGanZhi.gz),
    时空: calcXunKong(lunar.hourGanZhi.gz),
  };
}

function referenceShenPan(yinYangDun, zhifuStarGong) {
  const [, palace] = zhifuStarGong;
  const palaceNumber = GONG_NUMBER[palace];
  const values = (yinYangDun === '阳' ? GOD_PAN_YANG : GOD_PAN_YIN)[palaceNumber];
  if (!values) throw new Error(`无法识别值符落宫: ${palace}`);

  return Object.fromEntries(
    values
      .map((god, index) => [GONG_BY_NUMBER[index], god])
      .filter(([, god]) => god),
  );
}

function normalizeQimenPan(pan, dateInput) {
  const zhifuStarGong = pan.值符值使?.值符星宫;
  const normalized = {
    ...pan,
    旬空: buildFourPillarKong(dateInput),
    星: Object.fromEntries(
      Object.entries(pan.星 ?? {}).map(([palace, star]) => [
        palace,
        star === '禽' ? '芮禽' : star,
      ]),
    ),
    神: Object.fromEntries(
      Object.entries(pan.神 ?? {}).map(([palace, god]) => [
        palace,
        SHORT_GOD_MAP[god] ?? god,
      ]),
    ),
  };

  if (Array.isArray(zhifuStarGong)) {
    const referenceGods = referenceShenPan(pan.排局?.[0], zhifuStarGong);
    normalized.神 = referenceGods;
  }

  return normalized;
}

export async function runPaipan(input) {
  const dateInput = resolveDateInput(input);
  return normalizeQimenPan(new Qimen(dateInput).pan(), dateInput);
}

async function mainFromCli() {
  const input = await readStdin();
  const result = await runPaipan(input);
  console.log(JSON.stringify(result));
}

function isDirectRun() {
  // 浏览器/移动端 import 时没有 process；这里只让 Node CLI 兼容旧后端脚本执行方式。
  return isDirectCliRun(import.meta.url);
}

if (isDirectRun()) {
  mainFromCli().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}
