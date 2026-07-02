'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const NOTICE_SNOOZE_KEY = 'fateclaw-pre-use-notice-snoozed-date';

const noticeSections = [
  {
    title: '服务性质',
    items: [
      '本站本身不提供大模型训练、推理或内容生成服务，仅作为 Agent 工具与调用转发界面使用。',
      '本站转发调用的模型均以已备案、已接入合规渠道的模型服务为准，具体模型能力、服务可用性与内容安全规则以对应服务商为准。',
      '本站不是盈利性模型服务网站，当前仅作为 Agent 工具、开源实践与学习研究用途提供。',
    ],
  },
  {
    title: '使用边界',
    items: [
      '本站仅供学习、研究、测试与个人辅助参考使用，不应被用于违法违规、侵权、骚扰、诈骗或其他不当目的。',
      'AI 与 Agent 输出具有概率性、时效性和不确定性，可能出现遗漏、偏差或错误。',
      '本站内容不得等同于科学事实、专业结论、现实预测或决策依据；涉及法律、医疗、金融、投资、心理咨询等事项时，请以具备资质的专业人士意见为准。',
    ],
  },
  {
    title: '隐私与数据',
    items: [
      '为完成登录、会话、设备绑定、模型转发、故障排查与安全审计，本站可能保存必要的账号信息、会话记录、调用日志和设备状态。',
      '你提交的对话内容、提示词、文件片段或上下文可能会被转发至所选模型服务商处理；请勿提交身份证号、银行卡号、病历、精确住址、未成年人隐私、商业秘密等敏感信息。',
      '本站不会主动售卖个人信息，也不会收集与功能无关的数据；必要日志仅用于服务运行、安全合规、问题定位与滥用防控。',
      '继续使用即表示你已阅读、理解并同意本《用前须知与隐私说明》，并对自己的输入内容和使用结果承担相应责任。',
    ],
  },
];

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 全站用前须知弹窗。
 *
 * @returns 首次进入或当天未勾选免提醒时展示的合规告知弹窗。
 */
export function PreUseNoticeDialog() {
  const [open, setOpen] = useState(false);
  const [checkedToday, setCheckedToday] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(NOTICE_SNOOZE_KEY) === getLocalDateKey()) {
        return;
      }
    } catch {
      // localStorage 可能被隐私模式或浏览器策略禁用，此时仍展示须知。
    }

    setOpen(true);
  }, []);

  const handleAccept = () => {
    if (checkedToday) {
      try {
        window.localStorage.setItem(NOTICE_SNOOZE_KEY, getLocalDateKey());
      } catch {
        // 写入失败不影响本次继续使用，只是刷新后仍会再次提示。
      }
    }

    setOpen(false);
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[200] flex min-h-dvh items-center justify-center bg-ink/35 px-3 py-3 text-ink backdrop-blur-sm sm:px-6 sm:py-6">
      <section
        aria-labelledby="pre-use-notice-title"
        aria-modal="true"
        role="dialog"
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-3xl sm:max-h-[calc(100dvh-48px)]"
      >
        <div className="flex w-full flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-2xl shadow-ink/20">
          <div className="shrink-0 border-b border-hairline px-4 py-4 sm:px-7 sm:py-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary sm:size-10">
                <ShieldCheck size={20} aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">FateClaw Notice</p>
                <h1 id="pre-use-notice-title" className="mt-1 text-xl font-semibold text-ink sm:text-3xl">
                  用前须知与隐私说明
                </h1>
                <p className="mt-1.5 max-w-2xl text-xs leading-5 text-body sm:mt-2 sm:text-sm sm:leading-6">
                  请在继续使用前完整阅读以下内容。确认后今天不再重复提醒。
                </p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-7 sm:py-5">
            <div className="space-y-4 sm:space-y-5">
              {noticeSections.map((section) => (
                <section key={section.title} className="rounded-md border border-hairline-soft bg-surface-soft p-3.5 sm:p-4">
                  <h2 className="text-sm font-semibold text-body-strong sm:text-base">{section.title}</h2>
                  <ul className="mt-2.5 space-y-2 sm:mt-3 sm:space-y-2.5">
                    {section.items.map((item) => (
                      <li key={item} className="flex gap-2 text-xs leading-5 text-body sm:text-sm sm:leading-6">
                        <CheckCircle2 className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>

          <div className="shrink-0 border-t border-hairline bg-surface-soft px-4 py-3 safe-bottom sm:px-7 sm:py-4">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <p className="text-xs leading-5 text-muted">
                不同意以上内容时，请关闭本页面；同意后方可继续使用当前页面。
              </p>
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:items-end">
                <label className="flex min-h-5 cursor-pointer items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={checkedToday}
                    onChange={(event) => setCheckedToday(event.currentTarget.checked)}
                    className="size-4 shrink-0 accent-primary"
                  />
                  今日不再提醒
                </label>
                <Button size="md" className="w-full sm:h-12 sm:w-auto sm:px-6 sm:text-[15px]" onClick={handleAccept}>
                  我已阅读并同意
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
