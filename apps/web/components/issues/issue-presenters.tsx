import type {
  IssueAuthorDto,
  IssueDto,
  IssueEntryDto,
} from '@fateclaw/contracts';
import { CircleDot, CircleCheck } from 'lucide-react';

export const ISSUE_KIND_TEXT = { bug: '问题反馈', feature: '功能建议' };
export const ISSUE_LABEL_TEXT = {
  needs_info: '待补充',
  confirmed: '已确认',
  planned: '已计划',
  in_progress: '处理中',
};
export const ISSUE_REASON_TEXT = {
  resolved: '已解决',
  not_planned: '暂不计划',
  duplicate: '重复问题',
};
export function issueAuthorText(author: IssueAuthorDto) {
  return author.kind === 'official'
    ? '官方'
    : author.participant_number === 0
      ? '提问者'
      : `参与者 ${author.participant_number}`;
}
export function issueEventText(entry: IssueEntryDto) {
  const text = {
    comment: '',
    edited: '编辑了问题',
    closed: '关闭了问题',
    reopened: '重新打开了问题',
    labels_changed: '更新了标签',
    locked: '锁定了讨论',
    unlocked: '解除了讨论锁定',
  }[entry.type];
  return entry.type === 'closed' && entry.close_reason
    ? `${text} · ${ISSUE_REASON_TEXT[entry.close_reason]}`
    : text;
}
export function IssueStateBadge({ issue }: { issue: IssueDto }) {
  const Icon = issue.state === 'open' ? CircleDot : CircleCheck;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${issue.state === 'open' ? 'bg-primary/10 text-primary' : 'bg-surface-card text-muted'}`}
    >
      <Icon size={13} />
      {issue.state === 'open'
        ? '未关闭'
        : issue.close_reason
          ? ISSUE_REASON_TEXT[issue.close_reason]
          : '已关闭'}
    </span>
  );
}
