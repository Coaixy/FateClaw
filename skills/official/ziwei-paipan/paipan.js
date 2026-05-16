#!/usr/bin/env node

/**
 * 紫微斗数排盘脚本
 *
 * stdin:  JSON { solarDate, hour, minute?, gender, fixLeap? }
 * stdout: JSON 裁剪后的星盘
 */

import { astro } from 'iztro';

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  }
  return JSON.parse(text);
}

function hourToTimeIndex(hour, minute = 0) {
  if (hour === 23) return 12;
  if (hour === 0) return 0;
  return Math.floor((hour + 1) / 2);
}

function normalizeGender(g) {
  if (g === '男') return 'male';
  if (g === '女') return 'female';
  return g;
}

const HOROSCOPE_SCOPES = ['decadal', 'age', 'yearly', 'monthly', 'daily', 'hourly'];

function formatHoroscope(h, scopes) {
  const out = { solarDate: h.solarDate, lunarDate: h.lunarDate };
  for (const scope of scopes) {
    const s = h[scope];
    if (!s) continue;
    out[scope] = {
      name: s.name,
      heavenlyStem: s.heavenlyStem,
      earthlyBranch: s.earthlyBranch,
      mutagen: s.mutagen,
      palaceNames: s.palaceNames,
    };
    if (s.nominalAge !== undefined) out[scope].nominalAge = s.nominalAge;
  }
  return out;
}

function formatAstrolabe(a) {
  return {
    solarDate: a.solarDate,
    lunarDate: a.lunarDate,
    chineseDate: a.chineseDate,
    time: a.time,
    timeRange: a.timeRange,
    sign: a.sign,
    zodiac: a.zodiac,
    soul: a.soul,
    body: a.body,
    fiveElementsClass: a.fiveElementsClass,
    earthlyBranchOfSoulPalace: a.earthlyBranchOfSoulPalace,
    earthlyBranchOfBodyPalace: a.earthlyBranchOfBodyPalace,
    palaces: a.palaces.map((p) => ({
      name: p.name,
      isBodyPalace: p.isBodyPalace,
      isOriginalPalace: p.isOriginalPalace,
      heavenlyStem: p.heavenlyStem,
      earthlyBranch: p.earthlyBranch,
      majorStars: p.majorStars.map((s) => ({
        name: s.name,
        brightness: s.brightness,
        mutagen: s.mutagen,
      })),
      minorStars: p.minorStars.map((s) => ({
        name: s.name,
        brightness: s.brightness,
        mutagen: s.mutagen,
      })),
      decadal: p.decadal,
    })),
  };
}

export async function runPaipan(input) {
  const { solarDate, hour, minute = 0, gender, fixLeap = true, horoscope } = input;

  if (!solarDate || hour === undefined || !gender) {
    throw new Error('缺少必填参数: solarDate, hour, gender');
  }

  const timeIndex = hourToTimeIndex(hour, minute);
  const astrolabe = astro.bySolar(solarDate, timeIndex, normalizeGender(gender), fixLeap, 'zh-CN');
  const result = formatAstrolabe(astrolabe);

  if (horoscope?.date) {
    const scopes = horoscope.scopes ?? ['decadal', 'yearly'];
    const invalid = scopes.filter((s) => !HOROSCOPE_SCOPES.includes(s));
    if (invalid.length) throw new Error(`非法 horoscope scope: ${invalid.join(',')}`);
    result.horoscope = formatHoroscope(astrolabe.horoscope(horoscope.date), scopes);
  }

  return result;
}

async function mainFromCli() {
  const input = await readStdin();
  const result = await runPaipan(input);
  console.log(JSON.stringify(result, null, 2));
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
