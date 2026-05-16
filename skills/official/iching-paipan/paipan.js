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
  calcXunKong,
} from 'iching-shifa';

const METHODS = ['dayan', 'lueshifa', 'manual', 'three', 'array', 'time'];
const WUXING_RELATION_TO_LIUQIN = {
  比和: '兄弟',
  生我: '父母',
  我生: '子孙',
  尅我: '官鬼',
  我尅: '妻财',
};
const WUXING_GENERATES = {
  木: '火',
  火: '土',
  土: '金',
  金: '水',
  水: '木',
};
const WUXING_CONTROLS = {
  木: '土',
  土: '水',
  水: '火',
  火: '金',
  金: '木',
};
const TRADITIONAL_LIUSHOU = {
  腾蛇: '螣蛇',
};
const TRADITIONAL_GUA_NAME_MAP = {
  剝: '剥',
  漸: '渐',
};
const LINES_PER_TRIGRAM = 3;
const TRIGRAM_BY_LINES = {
  111: { name: '乾', image: '天' },
  '000': { name: '坤', image: '地' },
  100: { name: '震', image: '雷' },
  '011': { name: '巽', image: '风' },
  '010': { name: '坎', image: '水' },
  101: { name: '离', image: '火' },
  '001': { name: '艮', image: '山' },
  110: { name: '兑', image: '泽' },
};
const SHENSHA_MAPS = {
  yiMa: {
    子: '寅',
    丑: '亥',
    寅: '申',
    卯: '巳',
    辰: '寅',
    巳: '亥',
    午: '申',
    未: '巳',
    申: '寅',
    酉: '亥',
    戌: '申',
    亥: '巳',
  },
  tianXi: {
    子: '未',
    丑: '未',
    寅: '戌',
    卯: '戌',
    辰: '戌',
    巳: '丑',
    午: '丑',
    未: '丑',
    申: '辰',
    酉: '辰',
    戌: '辰',
    亥: '未',
  },
  wenChang: {
    甲: '巳',
    乙: '午',
    丙: '申',
    丁: '酉',
    戊: '申',
    己: '酉',
    庚: '亥',
    辛: '子',
    壬: '寅',
    癸: '卯',
  },
  zaiSha: {
    子: '午',
    丑: '卯',
    寅: '子',
    卯: '酉',
    辰: '午',
    巳: '卯',
    午: '子',
    未: '酉',
    申: '午',
    酉: '卯',
    戌: '子',
    亥: '酉',
  },
  jieSha: {
    子: '巳',
    丑: '寅',
    寅: '亥',
    卯: '申',
    辰: '巳',
    巳: '寅',
    午: '亥',
    未: '申',
    申: '巳',
    酉: '寅',
    戌: '亥',
    亥: '申',
  },
  mouXing: {
    子: '戌',
    丑: '未',
    寅: '辰',
    卯: '丑',
    辰: '戌',
    巳: '未',
    午: '辰',
    未: '丑',
    申: '戌',
    酉: '未',
    戌: '辰',
    亥: '丑',
  },
  tianYi: {
    子: '亥',
    丑: '子',
    寅: '丑',
    卯: '寅',
    辰: '卯',
    巳: '辰',
    午: '巳',
    未: '午',
    申: '未',
    酉: '申',
    戌: '酉',
    亥: '戌',
  },
  luMa: {
    甲: '寅',
    乙: '卯',
    丙: '巳',
    丁: '午',
    戊: '巳',
    己: '午',
    庚: '申',
    辛: '酉',
    壬: '亥',
    癸: '子',
  },
  yangRen: {
    甲: '卯',
    乙: '辰',
    丙: '午',
    丁: '巳',
    戊: '午',
    己: '巳',
    庚: '酉',
    辛: '申',
    壬: '子',
    癸: '亥',
  },
  huaGai: {
    子辰: '辰',
    丑丑: '丑',
    寅戌: '戌',
    卯未: '未',
    辰辰: '辰',
    巳丑: '丑',
    午戌: '戌',
    未未: '未',
    申辰: '辰',
    酉丑: '丑',
    戌戌: '戌',
    亥未: '未',
  },
  jiangXing: {
    子子: '子',
    丑酉: '酉',
    寅午: '午',
    卯卯: '卯',
    辰子: '子',
    巳酉: '酉',
    午午: '午',
    未卯: '卯',
    申子: '子',
    酉酉: '酉',
    戌午: '午',
    亥卯: '卯',
  },
};

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

function getWuXingRelation(source, target) {
  if (source === target) return '比和';
  if (WUXING_GENERATES[source] === target) return '生我';
  if (WUXING_GENERATES[target] === source) return '我生';
  if (WUXING_CONTROLS[source] === target) return '尅我';
  if (WUXING_CONTROLS[target] === source) return '我尅';
  throw new Error(`无法识别五行生克关系: ${source}/${target}`);
}

function liuQinByPalace(yaoWuXing, palaceWuXing) {
  return WUXING_RELATION_TO_LIUQIN[getWuXingRelation(yaoWuXing, palaceWuXing)];
}

function normalizeLiuShou(value) {
  return TRADITIONAL_LIUSHOU[value] ?? value;
}

function normalizeGuaNameText(name) {
  return [...name].map((char) => TRADITIONAL_GUA_NAME_MAP[char] ?? char).join('');
}

function getTrigramByYao(yaoList, startIndex) {
  const lines = yaoList
    .slice(startIndex, startIndex + LINES_PER_TRIGRAM)
    .map((yao) => (Number(yao.yaoValue) % 2 === 1 ? '1' : '0'))
    .join('');
  const trigram = TRIGRAM_BY_LINES[lines];
  if (!trigram) throw new Error(`无法识别三爻结构: ${lines}`);
  return trigram;
}

function normalizeGuaName(name, yaoList) {
  if (!Array.isArray(yaoList) || yaoList.length < LINES_PER_TRIGRAM * 2) {
    throw new Error(`无法补全卦名，爻列表不足: ${name}`);
  }

  const sortedYaoList = [...yaoList].sort((a, b) => a.position - b.position);
  const lower = getTrigramByYao(sortedYaoList, 0);
  const upper = getTrigramByYao(sortedYaoList, LINES_PER_TRIGRAM);
  if (upper.name === lower.name) return `${upper.name}为${upper.image}`;
  return `${upper.image}${lower.image}${normalizeGuaNameText(name)}`;
}

function patchGuaForReference(gua, palaceWuXing) {
  if (!gua) return gua;
  return {
    ...gua,
    guaName: normalizeGuaName(gua.guaName, gua.yaoList),
    yaoList: gua.yaoList.map((yao) => ({
      ...yao,
      liuQin: liuQinByPalace(yao.wuXing, palaceWuXing),
      liuShou: normalizeLiuShou(yao.liuShou),
    })),
  };
}

function patchFuShenForReference(benGua) {
  if (!Array.isArray(benGua?.fuShen)) return benGua;
  return {
    ...benGua,
    fuShen: benGua.fuShen.map((fu) => {
      // 伏神索引直接保留 0 基；这里只把它换算成 1 基爻位去补宿主信息。
      const hostYaoIndex = Number(fu.hostYaoIndex);
      const hostYao = benGua.yaoList.find(
        (yao) => yao.position === hostYaoIndex + 1,
      );
      return {
        ...fu,
        hostYaoIndex,
        hostNaJia: hostYao?.naJia ?? fu.hostNaJia,
        relation: getWuXingRelation(fu.fuWuXing, hostYao?.wuXing ?? fu.feiWuXing),
      };
    }),
  };
}

function pairShenShaByBranch(map, primary, branches) {
  for (const branch of branches) {
    const value = map[`${primary}${branch}`];
    if (value) return value;
  }
  return '';
}

function buildReferenceShenSha(rest) {
  const year = rest.ganZhiYear?.di ?? '';
  const month = rest.ganZhiMonth?.di ?? '';
  const dayGan = rest.ganZhiDay?.tian ?? '';
  const day = rest.ganZhiDay?.di ?? '';
  const hour = rest.ganZhiHour?.di ?? '';
  const branches = [year, month, day, hour];

  return {
    文昌: SHENSHA_MAPS.wenChang[dayGan] ?? '',
    驿马: SHENSHA_MAPS.yiMa[day] ?? '',
    将星: pairShenShaByBranch(SHENSHA_MAPS.jiangXing, year, [month, day, hour])
      || pairShenShaByBranch(SHENSHA_MAPS.jiangXing, day, [year, month, hour]),
    桃花: {
      子: '酉',
      丑: '午',
      寅: '卯',
      卯: '子',
      辰: '酉',
      巳: '午',
      午: '卯',
      未: '子',
      申: '酉',
      酉: '午',
      戌: '卯',
      亥: '子',
    }[day] ?? '',
    天喜: SHENSHA_MAPS.tianXi[month] ?? '',
    天医: SHENSHA_MAPS.tianYi[month] ?? '',
    谋星: SHENSHA_MAPS.mouXing[day] ?? '',
    华盖: pairShenShaByBranch(SHENSHA_MAPS.huaGai, year, [month, day, hour])
      || pairShenShaByBranch(SHENSHA_MAPS.huaGai, day, [year, month, hour]),
    灾煞: SHENSHA_MAPS.zaiSha[day] ?? '',
    劫煞: SHENSHA_MAPS.jieSha[day] ?? '',
    禄神: SHENSHA_MAPS.luMa[dayGan] ?? '',
    阳刃: SHENSHA_MAPS.yangRen[dayGan] ?? '',
  };
}

function patchPanForReference(pan) {
  const { benGua, zhiGua, huGua, ...rest } = pan;
  const patchedBenGua = patchFuShenForReference(
    patchGuaForReference(benGua, benGua.palaceWuXing),
  );
  return {
    ...rest,
    yearKong: calcXunKong(rest.ganZhiYear.gz),
    monthKong: calcXunKong(rest.ganZhiMonth.gz),
    shenSha: buildReferenceShenSha(rest),
    benGua: patchedBenGua,
    zhiGua: patchGuaForReference(zhiGua, benGua.palaceWuXing),
    huGua: patchGuaForReference(huGua, huGua?.palaceWuXing),
  };
}

export async function runPaipan(input) {
  const { method = 'dayan', question, datetime } = input;

  if (!METHODS.includes(method)) {
    throw new Error(`method 必须是 ${METHODS.join('/')} 之一`);
  }

  const when = parseDatetime(datetime);
  const yaoString = generateYao(method, input, when);

  const pan = patchPanForReference(decodePan(yaoString, {
    year: when.getFullYear(),
    month: when.getMonth() + 1,
    day: when.getDate(),
    hour: when.getHours(),
    minute: when.getMinutes(),
  }));

  function stripScripture(gua) {
    if (!gua) return gua;
    const { guaCi, yaoCi, tuanCi, ...rest } = gua;
    return rest;
  }

  const { benGua, zhiGua, huGua, ...rest } = pan;
  const result = {
    method,
    question,
    ...rest,
    benGua: stripScripture(benGua),
    zhiGua: stripScripture(zhiGua),
    huGua: stripScripture(huGua),
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
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return new URL(import.meta.url).pathname === process.argv[1];
}

if (isDirectRun()) {
  mainFromCli().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}
