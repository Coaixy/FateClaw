import { describe, expect, it, vi } from 'vitest';

import { createRequestScope } from '../request-scope.js';
import type { ToolSpec } from '../types.js';
import { executePiDirectTool } from './direct-tool-executor.js';

describe('executePiDirectTool', () => {
  it('executes a ToolSpec directly and records Pi observability without the legacy registry bridge', async () => {
    const requestScope = createRequestScope();
    const execute = vi.fn().mockResolvedValue({
      output: 'direct ok',
      modelOutput: 'model ok',
    });
    const spec: ToolSpec = {
      definition: {
        type: 'function',
        function: {
          name: 'direct_test',
          description: 'direct test',
          parameters: { type: 'object', properties: {} },
        },
      },
      prompt: 'direct test',
      execute,
    };

    const result = await executePiDirectTool({
      invocation: {
        id: 'direct-call',
        toolName: 'direct_test',
        args: { value: 1 },
        source: 'model',
      },
      spec,
      options: {
        requestScope,
        provider: 'pi-sdk',
        model: 'gpt-4o',
      },
    });

    expect(result.result.output).toBe('direct ok');
    expect(execute).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({
        requestScope,
        provider: 'pi-sdk',
        model: 'gpt-4o',
      }),
    );
    expect(requestScope.transcript).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        invocation: expect.objectContaining({ toolName: 'direct_test' }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        invocationId: 'direct-call',
        ok: true,
        output: 'direct ok',
        modelOutput: 'model ok',
      }),
    ]);
    expect(requestScope.traceEvents).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'direct_test',
        piDirectExecutor: true,
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolName: 'direct_test',
        piDirectExecutor: true,
      }),
    ]);
  });
});

