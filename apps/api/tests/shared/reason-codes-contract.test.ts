/**
 * reasonCode 跨包一致性契约测试。
 *
 * apps/agent-runtime 的构建产物刻意不依赖 @fateclaw/contracts（独立部署），
 * 因此在 agent-runtime/src/types.ts 维护了一份 PUBLIC_REASON_CODES 镜像。
 * 本测试是两份清单不发散的唯一防线：
 * 1. 镜像清单必须与 contracts 完全一致；
 * 2. 两侧错误映射器对同类错误必须产出相同的 reasonCode。
 */
import { describe, expect, it } from 'vitest';

import { PUBLIC_REASON_CODES as CONTRACT_CODES } from '@fateclaw/contracts';
// 跨 app 直接引用 agent-runtime 源码：仅测试期由 vitest 转译，不影响两个应用
// 各自的 tsc 构建边界（apps/api/tsconfig.json 只 include src/**）。
import { PUBLIC_REASON_CODES as AGENT_CODES } from '../../../agent-runtime/src/types.js';
import { mapContainerErrorToPublicError } from '../../../agent-runtime/src/public-error.js';
import { mapInternalErrorToPublicError } from '../../src/shared/public-error.js';

describe('reasonCode 跨包契约', () => {
  it('agent-runtime 的镜像清单与 contracts 完全一致', () => {
    expect([...AGENT_CODES].sort()).toEqual([...CONTRACT_CODES].sort());
  });

  it('两侧映射器对共同的错误特征产出相同的 reasonCode', () => {
    // 两侧共享的规则特征：超时 / 限流 / 上下文过长 / 缺输入 / 协议错误 / 默认内部错误。
    const sharedCases: Array<{ error: string; expected: string }> = [
      { error: 'request timed out after 480s', expected: 'agent_timeout' },
      { error: '429 rate limit exceeded', expected: 'rate_limited' },
      { error: '消息内容过长，超出 context 上限', expected: 'context_too_long' },
      { error: '还缺少这些信息：出生时间', expected: 'missing_input' },
      { error: '协议错误：unexpected tool payload', expected: 'protocol_error' },
      { error: '莫名其妙的未知失败', expected: 'internal_error' },
    ];

    for (const { error, expected } of sharedCases) {
      expect(
        mapInternalErrorToPublicError(error).publicReasonCode,
        `api 侧: ${error}`,
      ).toBe(expected);
      expect(
        mapContainerErrorToPublicError(error).publicReasonCode,
        `agent 侧: ${error}`,
      ).toBe(expected);
    }
  });

  it('两侧映射器产出的 reasonCode 都在 contracts 清单内', () => {
    const contractSet = new Set<string>(CONTRACT_CODES);
    const probes = [
      'timeout',
      'rate limit',
      'context too long',
      '还缺少这些信息：性别',
      '缺少必要输入',
      '协议错误',
      '路由失败',
      'anything else entirely',
      '',
    ];
    for (const probe of probes) {
      expect(contractSet.has(mapInternalErrorToPublicError(probe).publicReasonCode)).toBe(
        true,
      );
      if (probe) {
        expect(
          contractSet.has(mapContainerErrorToPublicError(probe).publicReasonCode),
        ).toBe(true);
      }
    }
    // agent 侧独有分支：自配模型错误。
    expect(
      mapContainerErrorToPublicError('401 unauthorized', {
        llmRuntime: {
          source: 'custom',
          billingMode: 'none',
          modelConfigId: 'm1',
          piApi: 'openai-completions',
          model: 'gpt-x',
          apiKey: 'sk-test-1234567890',
          authMode: 'openai_api_key',
          providerKey: 'custom-1',
        },
      }).publicReasonCode,
    ).toBe('custom_model_error');
  });
});
