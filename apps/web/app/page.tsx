import { redirect } from 'next/navigation';

export default function RootPage() {
  // B 端动线:卦师进门先看客户列表(给谁断卦),而非直接进对话。
  redirect('/clients');
}
