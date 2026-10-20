'use client';

import React from 'react';
import type {
  GaoDaoYiDuan,
  IchingGua,
  IchingYao,
} from '@/utils/chart/iching-utils';
import { CHART } from './chart-theme';
import { ChartDetails } from './chart-details';

interface JingzhanData {
  method?: string;
  benGua: IchingGua;
  zhiGua: IchingGua;
  huGua?: IchingGua;
  zongGua?: IchingGua;
  cuoGua?: IchingGua;
  dongYaoCount?: number;
  // 仅略筮法起卦时可能附带：高岛易断历史卦例解读。
  gaoDaoYiDuan?: GaoDaoYiDuan;
}

const YAO_POS = ['初', '二', '三', '四', '五', '上'];

function getDongYaoRule(count?: number): string | null {
  switch (count) {
    case 0:
      return '无变爻，以本卦卦辞断';
    case 1:
      return '一爻动，以动爻爻辞断';
    case 2:
      return '二爻动，以二动爻爻辞断，上爻为主';
    case 3:
      return '三爻动，以本卦、变卦卦辞合断';
    case 4:
      return '四爻动，以两静爻爻辞断';
    case 5:
      return '五爻动，以唯一静爻爻辞断';
    case 6:
      return '六爻皆动，乾用"用九"、坤用"用六"，余卦以变卦卦辞断';
    default:
      return null;
  }
}

function HexagramDiagram({
  yaoList,
  small = false,
  showMoving = false,
}: {
  yaoList: IchingYao[];
  small?: boolean;
  showMoving?: boolean;
}) {
  if (!yaoList || yaoList.length === 0) return null;
  return (
    <div
      className={`flex flex-col items-center ${small ? 'gap-[3px]' : 'gap-2 @[480px]/artifact:gap-2.5'} relative`}
    >
      {[...yaoList].reverse().map((yao, i) => {
        const originalIndex = yaoList.length - 1 - i;
        const isYang = yao.yaoValue === 7 || yao.yaoValue === 9;
        const isMoving =
          showMoving &&
          (yao.yaoValue === 6 || yao.yaoValue === 9 || yao.isMoving);
        const h = small
          ? 'h-[5px] @[480px]/artifact:h-[6px]'
          : 'h-5 @[480px]/artifact:h-6';
        const w = small
          ? 'w-8 @[480px]/artifact:w-10'
          : 'w-[clamp(4rem,29cqw,9rem)]';
        const bgClass = isMoving ? CHART.primaryBg : CHART.line;

        return (
          <div
            key={originalIndex}
            className={`flex justify-between items-center ${w} ${h} relative`}
          >
            {isYang ? (
              <div
                className={`w-full h-full ${bgClass} rounded-[1px] @[480px]/artifact:rounded-[2px] transition-colors`}
              />
            ) : (
              <>
                <div
                  className={`w-[44%] h-full ${bgClass} rounded-[1px] @[480px]/artifact:rounded-[2px] transition-colors`}
                />
                <div
                  className={`w-[44%] h-full ${bgClass} rounded-[1px] @[480px]/artifact:rounded-[2px] transition-colors`}
                />
              </>
            )}

            {/* 动爻指示标记 (比如古书里的小圆圈/小叉) */}
            {isMoving && !small && (
              <div className="absolute -right-5 @[480px]/artifact:-right-6 w-3 h-3 flex items-center justify-center">
                <span
                  className={`text-xs @[480px]/artifact:text-sm font-bold opacity-80 leading-none ${CHART.primary}`}
                >
                  {isYang ? 'O' : 'X'}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubGuaBox({ label, gua }: { label: string; gua: IchingGua }) {
  if (!gua?.yaoList) return null;
  return (
    <div className="flex-1 bg-surface-soft rounded-md flex items-center justify-center gap-2 @[480px]/artifact:gap-3 py-3 @[480px]/artifact:py-4 min-w-0">
      <div className="flex items-center justify-center shrink-0">
        <HexagramDiagram yaoList={gua.yaoList} small />
      </div>
      <div className="flex flex-col justify-center text-[10px] @[480px]/artifact:text-[11px] text-body leading-tight shrink-0">
        <span className={CHART.muted}>{label}:</span>
        <span className="font-medium text-ink mt-[3px]">
          {gua.guaName ?? '-'}
        </span>
      </div>
    </div>
  );
}

export default function JingzhanChart({ data }: { data: JingzhanData }) {
  const {
    benGua,
    zhiGua,
    huGua,
    zongGua,
    cuoGua,
    method,
    dongYaoCount,
    gaoDaoYiDuan,
  } = data;

  if (!benGua?.yaoList || !zhiGua?.yaoList) {
    return (
      <div className="text-center text-muted text-[12px] py-6 bg-surface-card rounded-xl border border-hairline">
        经占盘数据为空
      </div>
    );
  }

  const ruleText = getDongYaoRule(dongYaoCount);

  return (
    <div className="w-full bg-surface-card border border-hairline rounded-xl overflow-hidden font-sans shadow-sm">
      {/* Header Info */}
      {method && (
        <div className="px-3 @[480px]/artifact:px-4 py-2 border-b border-hairline-soft bg-surface-soft flex flex-col gap-0.5">
          <div className="text-[11px] @[480px]/artifact:text-xs text-muted">
            起卦: {method}
          </div>
        </div>
      )}

      {/* Big Hexagrams */}
      <div className="py-4 @[480px]/artifact:py-5 flex flex-col items-center bg-canvas overflow-hidden">
        <div className="flex items-end justify-center gap-2 @[480px]/artifact:gap-8 w-full mb-3 @[480px]/artifact:mb-4">
          <div className="text-[14px] @[480px]/artifact:text-[16px] font-bold text-ink tracking-wider w-24 @[480px]/artifact:w-32 text-center">
            【{benGua.guaName ?? '本卦'}】
          </div>
          <div className="flex flex-col items-center justify-center w-14 @[480px]/artifact:w-20 pb-0.5">
            {huGua ? (
              <span className="text-[10px] @[480px]/artifact:text-[12px] text-muted font-medium tracking-widest whitespace-nowrap">
                互: {huGua.guaName}
              </span>
            ) : (
              <span className="text-[14px] @[480px]/artifact:text-[16px] text-body font-medium">
                之
              </span>
            )}
          </div>
          <div className="text-[14px] @[480px]/artifact:text-[16px] font-bold text-ink tracking-wider w-24 @[480px]/artifact:w-32 text-center">
            【{zhiGua.guaName ?? '变卦'}】
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 @[480px]/artifact:gap-8 w-full relative">
          <div className="flex-1 flex justify-end">
            <HexagramDiagram yaoList={benGua.yaoList} showMoving />
          </div>
          {huGua ? (
            <div className="flex flex-col justify-center items-center w-16 @[480px]/artifact:w-24 shrink-0 opacity-60">
              <HexagramDiagram yaoList={huGua.yaoList} small />
            </div>
          ) : (
            <div className="w-16 @[480px]/artifact:w-24 shrink-0" />
          )}
          <div className="flex-1 flex justify-start">
            <HexagramDiagram yaoList={zhiGua.yaoList} />
          </div>
        </div>
      </div>

      {/* Zong, Cuo Section */}
      {(zongGua || cuoGua) && (
        <div className="flex justify-center gap-1.5 @[480px]/artifact:gap-2 px-2 @[480px]/artifact:px-3 pb-2 bg-canvas">
          {zongGua && <SubGuaBox label="综卦" gua={zongGua} />}
          {cuoGua && <SubGuaBox label="错卦" gua={cuoGua} />}
        </div>
      )}

      {/* Rule Section */}
      {ruleText && (
        <div className="text-center py-2 text-body text-[12px] @[480px]/artifact:text-[13px] border-t border-hairline-soft bg-surface-soft">
          {ruleText}
        </div>
      )}

      {/* Details Section */}
      <ChartDetails title="卦爻辞 · 彖辞">
        <div className="bg-canvas p-3 pt-0 @[480px]/artifact:p-4 @[480px]/artifact:pt-0 text-[12px] @[480px]/artifact:text-[13px] text-body leading-7 space-y-2">
          {/* 1. 卦辞 */}
          {benGua.guaCi && (
            <div>
              <span className="font-bold text-ink">【本卦卦辞】</span>：
              {benGua.guaCi}
            </div>
          )}
          {dongYaoCount === 3 && zhiGua.guaCi && (
            <div>
              <span className="font-bold text-ink">【变卦卦辞】</span>：
              {zhiGua.guaCi}
            </div>
          )}

          {/* 2. 爻辞 */}
          {benGua.yaoCi &&
            benGua.yaoList.map((y, i) => {
              const isMoving =
                y.isMoving || y.yaoValue !== zhiGua.yaoList[i]?.yaoValue;
              if (isMoving && benGua.yaoCi?.[i]) {
                return (
                  <div key={i}>
                    <span className="font-bold text-ink">
                      【{YAO_POS[i]}爻辞】
                    </span>
                    ：{benGua.yaoCi[i]}
                  </div>
                );
              }
              return null;
            })}

          {/* 3. 象 */}
          {benGua.tuanCi && (
            <div>
              <span className="font-bold text-ink">【本卦大象】</span>：
              {benGua.tuanCi}
            </div>
          )}
          {zhiGua.tuanCi && (
            <div>
              <span className="font-bold text-ink">【变卦大象】</span>：
              {zhiGua.tuanCi}
            </div>
          )}
        </div>
      </ChartDetails>

      {/* 高岛易断解读：仅略筮法起卦时附带，属历史卦例参考，默认收起，与上方经文取辞区分展示 */}
      {gaoDaoYiDuan && (
        <ChartDetails title="高岛易断解读">
          <div className="px-3 @[480px]/artifact:px-4 pb-3 @[480px]/artifact:pb-4 pt-0 text-[12px] @[480px]/artifact:text-[13px] text-body leading-7 space-y-2">
            {gaoDaoYiDuan.intro && (
              <div>
                <span className="font-bold text-ink">本卦总论</span>：
                {gaoDaoYiDuan.intro}
              </div>
            )}
            {gaoDaoYiDuan.movingLines.map((line) => (
              <div key={line.line}>
                <span className="font-bold text-ink">
                  【{YAO_POS[line.line - 1] ?? line.line}爻详解】
                </span>
                {line.title && <div>{line.title}</div>}
                {line.xiang && <div className={CHART.muted}>{line.xiang}</div>}
                {line.commentary && <div>{line.commentary}</div>}
              </div>
            ))}
          </div>
        </ChartDetails>
      )}
    </div>
  );
}
