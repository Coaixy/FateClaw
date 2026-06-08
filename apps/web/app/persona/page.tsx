import { AppShell } from '@/components/app-shell';
import { UserSoulCard } from '@/components/workspace/user-soul-card';

/**
 * 人格设置页面。
 *
 * @returns 独立的人格设置工作区，避免微信对话入口承载过多账户设置能力。
 */
export default function PersonaPage() {
  return (
    <AppShell>
      <div className="min-h-[70vh] space-y-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">人格设置</h2>
          <p className="mt-1 text-[12px] text-muted">
            维护统一注入站内 AI Chat 和微信对话的 Soul。
          </p>
        </div>

        <section className="rounded-2xl border border-hairline bg-surface-card/50 p-4 lg:p-5">
          <UserSoulCard />
        </section>
      </div>
    </AppShell>
  );
}
