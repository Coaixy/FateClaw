'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Terminal } from 'lucide-react';

import { CodeBlock, CopyButton } from '@/components/developer/code-block';
import { useOpenApiBase } from '@/features/api-keys/use-open-api-base';

const LANGUAGES = ['cURL', 'Python', 'JavaScript'] as const;

function requestExample(language: (typeof LANGUAGES)[number], baseUrl: string) {
  if (language === 'Python') {
    return `import json, os
from urllib.request import Request, urlopen

request = Request(
    "${baseUrl}/paipan/bazi",
    data=json.dumps({"solar_date": "2000-08-16", "hour": 14,
                     "gender": "male"}).encode(),
    headers={"Authorization": "Bearer " + os.environ["FATECLAW_API_KEY"],
             "Content-Type": "application/json"},
)
with urlopen(request, timeout=60) as response:
    print(json.load(response)["text"])`;
  }
  if (language === 'JavaScript') {
    return `// Node.js: run on your server.
const response = await fetch("${baseUrl}/paipan/bazi", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.FATECLAW_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ solar_date: "2000-08-16", hour: 14, gender: "male" }),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(await response.text());
console.log((await response.json()).text);`;
  }
  return `curl --fail-with-body --max-time 60 \\
  "${baseUrl}/paipan/bazi" \\
  -H "Authorization: Bearer $FATECLAW_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"solar_date":"2000-08-16","hour":14,"gender":"male"}'`;
}

export function ApiQuickstart({
  onCreate,
  disabled,
}: {
  onCreate: () => void;
  disabled: boolean;
}) {
  const baseUrl = useOpenApiBase();
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>('cURL');

  return (
    <section
      aria-labelledby="quickstart-title"
      className="mb-9 overflow-hidden rounded-2xl border border-hairline bg-surface-soft/60"
    >
      <div className="grid gap-7 p-5 sm:p-7 xl:grid-cols-[0.85fr_1.15fr] xl:gap-10">
        <div className="flex flex-col items-start">
          <span className="mb-4 inline-flex items-center gap-2 text-[11px] font-medium text-primary">
            <Terminal size={14} aria-hidden="true" />
            快速接入
          </span>
          <h2
            id="quickstart-title"
            className="text-[22px] font-medium leading-snug text-ink"
          >
            从第一个请求开始。
          </h2>
          <p className="mt-2 text-[13px] leading-6 text-muted">
            生成密钥，连接你的应用。一次请求即可获得完整盘面。
          </p>
          <ol className="my-5 space-y-3 text-[12px] text-body">
            <li className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-canvas font-mono text-[10px] text-muted">
                1
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={onCreate}
                className="text-primary hover:underline disabled:text-muted disabled:no-underline"
              >
                生成 API Key
              </button>
              <span className="text-muted">并保存密钥</span>
            </li>
            <li className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-canvas font-mono text-[10px] text-muted">
                2
              </span>
              在服务端设置{' '}
              <code className="font-mono text-[11px]">FATECLAW_API_KEY</code>
            </li>
            <li className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-canvas font-mono text-[10px] text-muted">
                3
              </span>
              运行示例，读取返回的{' '}
              <code className="font-mono text-[11px]">text</code> 盘面
            </li>
          </ol>
          <Link
            href="/docs/api#start-flow"
            className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-ink hover:text-primary"
          >
            查看完整接入指南
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>

        <div className="min-w-0 self-center">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex gap-1" aria-label="示例语言">
              {LANGUAGES.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={language === item}
                  onClick={() => setLanguage(item)}
                  className={`min-h-8 rounded-md px-2.5 font-mono text-[11px] transition-colors ${language === item ? 'bg-surface-cream-strong text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <span className="hidden items-center gap-1 text-[10px] text-muted sm:inline-flex">
              <Check size={11} aria-hidden="true" />
              排盘不扣积分
            </span>
          </div>
          <CodeBlock language={language} title="POST /paipan/bazi">
            {requestExample(language, baseUrl)}
          </CodeBlock>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            将已保存的密钥设为环境变量后运行；请在服务端调用。
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline bg-canvas/70 px-5 py-2.5 sm:px-7">
        <span className="shrink-0 text-[11px] text-muted">Base URL</span>
        <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">
          {baseUrl}
        </code>
        <CopyButton value={baseUrl} label="复制地址" />
      </div>
    </section>
  );
}
