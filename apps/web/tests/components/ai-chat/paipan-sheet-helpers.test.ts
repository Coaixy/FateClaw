import { describe, expect, it } from 'vitest';

import { PAIPAN_SHEET_HELPERS as helpers } from '@/components/ai-chat/paipan-sheet-helpers';

describe('chart method submissions', () => {
  it('retains the selected Mingfa method when using the current time', () => {
    expect(
      helpers.buildSubmitInputForSkill('qimen-paipan', {
        $useCurrentTime: true,
        panType: '鸣法',
        solarDate: '2026-06-02',
        hour: 12,
      }),
    ).toEqual({ panType: '鸣法' });
  });

  it('submits ancient inputs independently of stale time-mode fields', () => {
    const draft = {
      method: 'yuejiang',
      yueJiang: '亥',
      shiChen: '未',
      riGanZhi: '丁巳',
      $useCurrentTime: true,
      $liurenTimeMode: 'random',
      solarDate: '2026-06-02',
      hour: 12,
      randomNumber: 8848,
    };
    expect(helpers.validateDraftForSkill('liuren-paipan', draft)).toBeNull();
    expect(helpers.buildSubmitInputForSkill('liuren-paipan', draft)).toEqual({
      method: 'yuejiang',
      yueJiang: '亥',
      shiChen: '未',
      riGanZhi: '丁巳',
    });
    expect(
      helpers.validateDraftForSkill('liuren-paipan', {
        ...draft,
        riGanZhi: '丁午',
      }),
    ).toBeTruthy();
  });
});
