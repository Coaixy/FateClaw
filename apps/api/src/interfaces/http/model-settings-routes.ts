import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  type AdminOfficialModelView,
  getUserModelSettingsOverview,
  saveUserCustomModelConfig,
  setUserCustomModelSecret,
  setUserModelSelection,
  type UserModelSettingsOverview,
} from '../../modules/system/system-config.js';
import {
  MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS,
  MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
} from '../../shared/model-context-window.js';
import type {
  ModelSettingsOverviewDto,
  OfficialModelDto,
  UserCustomModelConfigDto,
} from '@fateclaw/contracts/model-settings';

const AuthModeSchema = z
  .enum([
    'openai_api_key',
    'anthropic_api_key',
    'claude_code_oauth_token',
    'gemini_api_key',
  ])
  .optional();

const CustomModelSchema = z.object({
  pi_api: z.enum([
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ]),
  base_url: z.string().trim().max(500).nullable().optional(),
  model_name: z.string().trim().min(1).max(120),
  context_window_tokens: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS)
    .refine(
      (value) => value === 0 || value >= MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
      `context_window_tokens 必须为 0，或不小于 ${MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS}`,
    )
    .nullable()
    .optional(),
  auth_mode: AuthModeSchema,
  api_key: z.string().trim().min(1).max(2000).optional(),
});

const CustomSecretSchema = z.object({
  api_key: z.string().trim().min(1).max(2000),
  auth_mode: AuthModeSchema,
});

const SelectionSchema = z.object({
  source: z.enum(['custom', 'official']),
  official_model_id: z.string().trim().min(1).nullable().optional(),
});

function toConfiguredContextWindowTokens(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  return value && value > 0 ? value : null;
}

function toOfficialModelDto(model: AdminOfficialModelView): OfficialModelDto {
  return {
    id: model.id,
    model_key: model.model_key,
    pi_api: model.pi_api,
    display_name: model.display_name,
    description: model.description,
    enabled: model.enabled,
    priority: model.priority,
    base_url: model.base_url,
    model_name: model.model_name,
    context_window_tokens: model.context_window_tokens,
    input_token_price_per_million_coins:
      model.input_token_price_per_million_coins,
    output_token_price_per_million_coins:
      model.output_token_price_per_million_coins,
    has_secret: model.has_secret,
    auth_mode: model.auth_mode,
  };
}

function toCustomModelDto(
  custom: UserModelSettingsOverview['custom'],
): UserCustomModelConfigDto | null {
  if (!custom) return null;
  return {
    user_id: custom.user_id,
    pi_api: custom.pi_api,
    base_url: custom.base_url,
    model_name: custom.model_name,
    context_window_tokens: custom.context_window_tokens,
    has_secret: custom.has_secret,
    auth_mode: custom.auth_mode,
    created_at: custom.created_at,
    updated_at: custom.updated_at,
  };
}

function toModelSettingsOverviewDto(
  overview: UserModelSettingsOverview,
): ModelSettingsOverviewDto {
  return {
    custom: toCustomModelDto(overview.custom),
    selection: overview.selection,
    official_models: overview.official_models.map(toOfficialModelDto),
  };
}

export async function modelSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  app.get('/', async (request) => {
    const overview = await getUserModelSettingsOverview(request.user.userId);
    return toModelSettingsOverviewDto(overview);
  });

  app.get('/official-models', async (request) => {
    const overview = await getUserModelSettingsOverview(request.user.userId);
    return overview.official_models.map(toOfficialModelDto);
  });

  app.put('/custom', async (request, reply) => {
    const parsed = CustomModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return saveUserCustomModelConfig({
      userId: request.user.userId,
      piApi: parsed.data.pi_api,
      baseUrl: parsed.data.base_url?.trim() || null,
      modelName: parsed.data.model_name,
      contextWindowTokens: toConfiguredContextWindowTokens(
        parsed.data.context_window_tokens,
      ),
      authMode: parsed.data.auth_mode,
      secretValue: parsed.data.api_key,
    });
  });

  app.post('/custom/secret', async (request, reply) => {
    const parsed = CustomSecretSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      await setUserCustomModelSecret({
        userId: request.user.userId,
        secretValue: parsed.data.api_key,
        authMode: parsed.data.auth_mode,
      });
      return { success: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '保存失败' });
    }
  });

  app.put('/selection', async (request, reply) => {
    const parsed = SelectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      return await setUserModelSelection({
        userId: request.user.userId,
        source: parsed.data.source,
        officialModelId: parsed.data.official_model_id ?? null,
      });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '选择失败' });
    }
  });
}
