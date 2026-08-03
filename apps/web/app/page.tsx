import { AiChatWorkspace } from '@/components/ai-chat/ai-chat-workspace';

/**
 * 根路径直接进入新建对话，与侧栏“新建对话”和 AI Chat 空会话保持同一套流程。
 *
 * @returns AI Chat 工作区。
 */
export default function HomePage() {
  return <AiChatWorkspace />;
}
