// 爻值：6=老阴（变阳） 7=少阳（静） 8=少阴（静） 9=老阳（变阴）
export type YaoValue = 6 | 7 | 8 | 9;

export interface IchingYao {
  position: number; // 1=初 .. 6=上
  yaoValue: YaoValue;
  isMoving: boolean;
  naJia?: string;
  naYin?: string;
  wuXing: string;
  liuQin: string;
  liuShou: string;
  shiYing: string; // '世' | '应' | '初' | '二' | '三' | '四' | '五' | '六'
  suiXian?: {
    startAge: number;
    endAge: number;
  };
  xingXiu?: string;
  suoBo?: string;
}

export interface IchingFuShen {
  fuLiuQin: string;
  fuNaJia: string;
  fuNaYin?: string;
  fuWuXing: string;
  // 新版 iching-shifa 使用 1 基爻位，和 yao.position 保持一致。
  hostPosition: number;
}

export interface IchingGua {
  guaName?: string;
  palace?: string;
  palaceWuXing?: string;
  palaceLevel?: string;
  yaoList: IchingYao[];
  guaCi?: string;
  yaoCi?: string[];
  tuanCi?: string;
  shenYao?: number;
  fuShen?: IchingFuShen[];
  pangFuShen?: IchingFuShen[];
}

// 高岛易断单条动爻详解（爻辞 + 象辞 + 逐句详解）。
export interface GaoDaoYiDuanLine {
  line: number;
  title: string;
  xiang: string;
  commentary: string;
}

// 高岛易断解读：本卦总论 + 动爻详解，经占仅略筮法起卦时附带。
export interface GaoDaoYiDuan {
  guaName: string;
  intro: string;
  movingLines: GaoDaoYiDuanLine[];
}

// true 表示阳爻（—），false 表示阴爻（x）
export function isYang(value: number): boolean {
  return value === 7 || value === 9;
}

// 世应判断：shiYing 字段为 '世' / '應'（繁体） 或其他位置名
export function isShi(shiYing: string | undefined): boolean {
  return shiYing === '世';
}
export function isYing(shiYing: string | undefined): boolean {
  return shiYing === '應' || shiYing === '应';
}
export function getShiYingLabel(shiYing: string | undefined): '世' | '应' | '' {
  if (isShi(shiYing)) return '世';
  if (isYing(shiYing)) return '应';
  return '';
}
