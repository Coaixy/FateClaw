import type { Metadata } from 'next';

import { AcknowledgementsPage } from '@/components/acknowledgements-page';

export const metadata: Metadata = {
  title: '开源鸣谢 | FateClaw',
  description: '感谢支持 FateClaw 的开源项目、作者、维护者与贡献者。',
};

export default function Page() {
  return <AcknowledgementsPage />;
}
