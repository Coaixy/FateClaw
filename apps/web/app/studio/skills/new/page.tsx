'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  SkillBundleEditor,
  SkillBundleEditorData,
  createDefaultSkillBundleFiles,
} from '@/components/skills/skill-bundle-editor';
import { skillsApi } from '@/features/skills/api';
import { useToast } from '@/lib/use-toast';

export default function NewStudioSkillPage() {
  const router = useRouter();
  const { toast } = useToast();

  const handleCreate = async (data: SkillBundleEditorData) => {
    await skillsApi.userCreate(data);
    toast('success', 'Skill Bundle 已创建');
    router.push('/studio');
  };

  return (
    <AppShell wide>
      <div className="space-y-4">
        <Link
          href="/studio"
          className="inline-flex min-h-10 items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={13} />
          返回术数开发
        </Link>
        <SkillBundleEditor
          initial={{
            id: '',
            user_id: '',
            skill_name: '我的 Skill',
            dir_name: '',
            description: '',
            version: '1.0.0',
            bundle_uri: '',
            checksum: null,
            install_status: 'missing',
            acl: {},
            billing_policy: {},
            audit_metadata: {},
            files: createDefaultSkillBundleFiles('我的 Skill'),
            content_length: 0,
            visibility: 'private',
            share_token: null,
            enabled: true,
            price_tiers: [],
            stat_subscriber_count: 0,
            stat_view_count: 0,
            created_at: '',
            updated_at: '',
          }}
          onSave={handleCreate}
        />
      </div>
    </AppShell>
  );
}
