import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  RegistrationInviteDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? `${key}[${Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')}]`
        : key,
    formatDate: (value: string) => value,
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      options?.signDisplay === 'always' && value >= 0 ? `+${value}` : String(value),
  }),
}));

import { InvitationsContent } from '@/components/invitations/invitations-workspace';

const invitation: RegistrationInviteDto = {
  id: 'invite-1',
  code_suffix: '1234',
  source: 'user',
  status: 'active',
  created_at: '2026-10-17T00:00:00Z',
  expires_at: '2026-10-24T00:00:00Z',
  used_at: null,
};

const summary: RegistrationInviteSummaryDto = {
  user_id: 'user-1',
  policy: {
    tiers: [
      { threshold_yuan: 30, total_slots: 3 },
      { threshold_yuan: 100, total_slots: 5 },
      { threshold_yuan: 300, total_slots: 10 },
    ],
    expires_in_days: 7,
    revision: 1,
  },
  net_recharge_yuan: 100,
  eligible: true,
  eligibility_reason: 'eligible',
  total_slots: 5,
  automatic_slots: 5,
  manual_slot_adjustment: 0,
  used_slots: 0,
  reserved_slots: 1,
  available_slots: 4,
  suspended: false,
  revision: 1,
  invitations: [invitation],
};

function render(
  patch: Partial<ComponentProps<typeof InvitationsContent>> = {},
) {
  return renderToStaticMarkup(
    <InvitationsContent
      summary={summary}
      created={null}
      loading={false}
      loadError=""
      actionError=""
      pending={null}
      retrying={false}
      onRefresh={vi.fn()}
      onGenerate={vi.fn()}
      onRevoke={vi.fn()}
      onCopy={vi.fn()}
      onDismiss={vi.fn()}
      {...patch}
    />,
  );
}

function generateButton(html: string) {
  return html
    .match(
      /<button[^>]*>[^]*?invitations\.(?:generate|retryCreate)<\/button>/,
    )?.[0]
    .split('<button')
    .pop();
}

describe('invitation management', () => {
  it('shows only suffixes and allows revocation of unused invitations', () => {
    const html = render();
    expect(html).toContain('•••• 1234');
    expect(html).toContain('invitations.revoke');
    expect(html).not.toContain('invitations.copyCode');
    expect(generateButton(html)).not.toContain(' disabled=""');
  });

  it('blocks generation below the threshold while preserving recharge guidance', () => {
    const html = render({
      summary: {
        ...summary,
        eligible: false,
        eligibility_reason: 'below_threshold',
        net_recharge_yuan: 20,
        automatic_slots: 0,
        total_slots: 0,
        reserved_slots: 0,
        available_slots: 0,
        invitations: [],
      },
    });
    expect(generateButton(html)).toContain(' disabled=""');
    expect(html).toContain('invitations.nextTierRemaining[amount=10,slots=3]');
    expect(html).toContain('href="/membership"');
  });

  it('shows the configured cumulative ladder and keeps manual additions distinct', () => {
    const html = render({
      summary: {
        ...summary,
        policy: {
          ...summary.policy,
          tiers: [
            { threshold_yuan: 10, total_slots: 2 },
            { threshold_yuan: 80, total_slots: 4 },
            { threshold_yuan: 500, total_slots: 12 },
          ],
        },
        net_recharge_yuan: 80,
        automatic_slots: 4,
        manual_slot_adjustment: 2,
        total_slots: 6,
        available_slots: 5,
      },
    });
    for (const amount of [10, 80, 500]) {
      expect(html).toContain(`invitations.tierThreshold[amount=${amount}]`);
    }
    for (const count of [2, 4, 12]) {
      expect(html).toContain(`invitations.tierSlots[count=${count}]`);
    }
    expect(html).toContain('invitations.automaticAllowance[count=4]');
    expect(html).toContain('invitations.manualAdjustment[count=+2]');
    expect(html).toContain('invitations.nextTierRemaining[amount=420,slots=12]');
  });

  it('shows progress toward the next tier after invitations are unlocked', () => {
    const html = render({
      summary: {
        ...summary,
        net_recharge_yuan: 30,
        automatic_slots: 3,
        total_slots: 3,
        available_slots: 2,
      },
    });
    expect(html).toContain('invitations.nextTierRemaining[amount=70,slots=5]');
    expect(html).toContain('value="30" max="100"');
    expect(html).toContain('href="/membership"');
    expect(html).not.toContain('invitations.highestTierReached');
  });

  it('marks the highest tier without offering recharge or recreating historically used slots', () => {
    const html = render({
      summary: {
        ...summary,
        net_recharge_yuan: 300,
        automatic_slots: 10,
        total_slots: 12,
        used_slots: 12,
        reserved_slots: 0,
        available_slots: 0,
        invitations: [],
      },
    });
    expect(html).toContain('invitations.highestTierReached');
    expect(html).toContain('invitations.automaticAllowance[count=10]');
    expect(html).toContain('invitations.totalSlots[count=12]');
    expect(html).not.toContain('invitations.nextTierRemaining');
    expect(html).not.toContain('href="/membership"');
    expect(generateButton(html)).toContain(' disabled=""');
  });

  it('does not offer revocation for registered invitations', () => {
    const html = render({
      summary: {
        ...summary,
        invitations: [
          { ...invitation, status: 'used', used_at: '2026-10-18T00:00:00Z' },
        ],
      },
    });
    expect(html).toContain('invitations.status.used');
    expect(html).not.toContain('invitations.revoke');
  });

  it('offers the complete code only in the successful creation response', () => {
    const html = render({
      created: { invite: invitation, code: 'one-time-plaintext' },
    });
    expect(html).toContain('value="one-time-plaintext"');
    expect(html).toContain('invitations.oneTimeNotice');
    expect(html).toContain('invitations.copyLink');
    expect(generateButton(html)).toContain(' disabled=""');
  });

  it('guides a replayed creation to revoke and regenerate without inventing a code', () => {
    const html = render({ created: { invite: invitation, code: null } });
    expect(html).toContain('invitations.replayedNotice');
    expect(html).toContain('invitations.revokeAndRelease');
    expect(html).not.toContain('invitations.copyLink');
    expect(html).not.toContain('<input');
  });

  it('permits retrying the same creation after the last slot was reserved', () => {
    const html = render({
      summary: { ...summary, available_slots: 0, reserved_slots: 3 },
      retrying: true,
    });
    expect(html).toContain('invitations.retryCreate');
    expect(generateButton(html)).not.toContain(' disabled=""');
  });
});
