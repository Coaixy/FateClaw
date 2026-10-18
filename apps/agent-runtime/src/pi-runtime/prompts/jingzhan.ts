export function getJingzhanPrompt(skill: string): string | null {
  if (skill !== 'jingzhan-paipan' && skill !== 'user-pasted-board::经占') {
    return null;
  }
  return '解读此经占盘面时，不要使用六爻的解卦方法。';
}
