'use client';

import { ArrowUpRight, ChevronDown, Heart } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  creditGroups,
  type ProjectCredit,
} from '@/features/acknowledgements/projects';
import { useI18n } from '@/lib/i18n';

export function AcknowledgementsPage() {
  const { t, formatNumber } = useI18n();

  return (
    <AppShell wide requireAuth={false}>
      <div className="mx-auto max-w-4xl pb-4 pt-8 lg:pt-3">
        <header className="border-b border-hairline pb-8 sm:pb-10">
          <p className="mb-5 flex items-center gap-2 text-xs text-primary">
            <Heart size={15} aria-hidden="true" />
            {t('acknowledgements.eyebrow')}
          </p>
          <h1 className="font-display text-4xl font-medium tracking-tight text-ink sm:text-5xl">
            {t('acknowledgements.title')}
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-body sm:text-base sm:leading-8">
            {t('acknowledgements.introduction')}
          </p>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted">
            {t('acknowledgements.thanks')}
          </p>
        </header>

        <nav
          aria-label={t('acknowledgements.contents')}
          className="flex flex-wrap gap-x-5 gap-y-1 border-b border-hairline py-4"
        >
          {creditGroups.map((group) => (
            <a
              key={group.id}
              href={`#${group.id}`}
              onClick={() => {
                const section = document.getElementById(group.id);
                if (section instanceof HTMLDetailsElement) section.open = true;
              }}
              className="inline-flex min-h-9 items-center text-xs text-muted underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              {t(`acknowledgements.groups.${group.id}`)}
            </a>
          ))}
        </nav>

        <div className="mt-8 space-y-8 sm:mt-10 sm:space-y-10">
          {creditGroups.map((group, index) => (
            <details
              key={group.id}
              id={group.id}
              open={index < 2}
              className="group/section scroll-mt-20 border-b border-hairline pb-6"
            >
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden="true"
                  className="font-mono text-[11px] text-primary"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h2 className="flex-1 font-display text-xl font-medium text-ink sm:text-2xl">
                  {t(`acknowledgements.groups.${group.id}`)}
                </h2>
                <span className="text-xs tabular-nums text-muted">
                  {t('acknowledgements.projectCount', {
                    count: formatNumber(group.projects.length),
                  })}
                </span>
                <ChevronDown
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-muted transition-transform group-open/section:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {group.projects.map((project) => (
                  <ProjectCard key={project.name} project={project} />
                ))}
              </ul>
            </details>
          ))}
        </div>

        <footer className="mt-10 rounded-xl border border-hairline bg-surface-soft px-5 py-6 sm:px-6">
          <h2 className="text-sm font-medium text-ink">
            {t('acknowledgements.licenseTitle')}
          </h2>
          <p className="mt-2 text-xs leading-6 text-body">
            {t('acknowledgements.projectLicense')}{' '}
            <a
              href="https://www.gnu.org/licenses/gpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
            >
              GPL-3.0-only
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          </p>
          <p className="mt-2 text-xs leading-6 text-muted">
            {t('acknowledgements.licenseNote')}
          </p>
          <p className="mt-4 text-xs leading-6 text-muted">
            {t('acknowledgements.communityThanks')}
          </p>
        </footer>
      </div>
    </AppShell>
  );
}

function ProjectCard({ project }: { project: ProjectCredit }) {
  const { t } = useI18n();

  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-hairline bg-surface-raised/50 px-4 py-4 transition-colors hover:border-primary/30 sm:px-5">
      <a
        href={project.href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-8 items-start justify-between gap-3 rounded-sm text-sm font-medium text-ink hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{project.name}</span>
        <ArrowUpRight
          size={14}
          aria-hidden="true"
          className="mt-1 shrink-0 text-muted"
        />
      </a>
      <p className="mt-1 text-xs leading-6 text-body">
        {t(`acknowledgements.roles.${project.role}`)}
      </p>
      {project.note && (
        <p className="mt-2 text-xs leading-6 text-muted">
          {t(`acknowledgements.notes.${project.note}`)}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-4">
        <a
          href={project.licenseHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('acknowledgements.viewLicense', {
            project: project.name,
            license: project.license,
          })}
          className="inline-flex min-h-8 items-center rounded-md border border-hairline px-2.5 py-1 font-mono text-[10px] leading-5 text-body transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary [overflow-wrap:anywhere]"
        >
          {project.license}
        </a>
        {project.version && (
          <span className="font-mono text-[10px] leading-5 text-muted [overflow-wrap:anywhere]">
            {project.version}
          </span>
        )}
      </div>
    </li>
  );
}
