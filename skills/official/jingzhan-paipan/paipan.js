#!/usr/bin/env node

/**
 * 周易六爻排盘脚本（基于 iching-shifa，本地计算）
 *
 * stdin:  JSON { method?, yao?, numbers?, datetime?, question? }
 * stdout: JSON 排盘结果
 */

import {
  dayan,
  lueshifa,
  manualQiGua,
  threeNumberQiGua,
  numberArrayQiGua,
  timeQiGua,
  decodePan,
  solarToLunar,
} from 'iching-shifa';
import { isDirectCliRun } from '../_shared/cli-entry.js';

const METHODS = ['dayan', 'lueshifa', 'manual', 'three', 'array', 'time'];

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  }
  return JSON.parse(text);
}

function parseDatetime(s) {
  if (!s) return new Date();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  if (isNaN(d.getTime())) throw new Error(`非法 datetime: ${s}`);
  return d;
}

function hourToZhiIndex(hour) {
  if (hour === 23 || hour === 0) return 1;
  return Math.floor((hour + 1) / 2) + 1;
}

function generateYao(method, input, when) {
  const { yao, numbers } = input;
  switch (method) {
    case 'dayan':
      return dayan();
    case 'lueshifa':
      return lueshifa();
    case 'manual':
      if (!yao) throw new Error('method=manual 需要 yao（6位爻字符串，如 "789678"）');
      return manualQiGua(yao);
    case 'three':
      if (!Array.isArray(numbers) || numbers.length !== 3) {
        throw new Error('method=three 需要 numbers 长度为 3');
      }
      return threeNumberQiGua(numbers[0], numbers[1], numbers[2]);
    case 'array': {
      if (!Array.isArray(numbers) || numbers.length < 2) {
        throw new Error('method=array 需要 numbers 长度 >= 2');
      }
      return numberArrayQiGua(numbers, hourToZhiIndex(when.getHours()));
    }
    case 'time': {
      const lunar = solarToLunar(
        when.getFullYear(),
        when.getMonth() + 1,
        when.getDate(),
        when.getHours(),
      );
      return timeQiGua(
        when.getFullYear(),
        when.getMonth() + 1,
        when.getDate(),
        when.getHours(),
        lunar.month,
        lunar.day,
        lunar.yearGanZhi.di,
        lunar.hourGanZhi.di,
      );
    }
    default:
      throw new Error(`非法 method: ${method}`);
  }
}

export async function runPaipan(input) {
  const { method = 'dayan', question, datetime } = input;

  if (!METHODS.includes(method)) {
    throw new Error(`method 必须是 ${METHODS.join('/')} 之一`);
  }

  const when = parseDatetime(datetime);
  const yaoString = generateYao(method, input, when);

  const pan = decodePan(yaoString, {
    year: when.getFullYear(),
    month: when.getMonth() + 1,
    day: when.getDate(),
    hour: when.getHours(),
    minute: when.getMinutes(),
  });

  function stripLiuyaoFromYao({ liuQin, liuShou, tianGan, diZhi, wuXing, naJia, shiYing, ...rest }) {
    return rest;
  }

  function stripLiuyao(gua) {
    if (!gua) return gua;
    const { fuShen, ...rest } = gua;
    return {
      ...rest,
      yaoList: rest.yaoList?.map(stripLiuyaoFromYao),
    };
  }

  const {
    benGua, zhiGua, huGua,
    ganZhiYear, ganZhiMonth, ganZhiDay, ganZhiHour,
    solarTerm, dayKong, hourKong, monthJian,
    ...rest
  } = pan;
  const result = {
    method,
    question,
    ...rest,
    benGua: stripLiuyao(benGua),
    zhiGua: stripLiuyao(zhiGua),
    huGua: stripLiuyao(huGua),
  };
  return result;
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
