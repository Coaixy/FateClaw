export class DirectPaipanError extends Error {
  constructor(
    public code:
      | 'PAIPAN.SKILL_NOT_FOUND'
      | 'PAIPAN.SKILL_NOT_ENABLED'
      | 'PAIPAN.SKILL_UNSUPPORTED'
      | 'PAIPAN.PARAM_INVALID'
      | 'PAIPAN.EXECUTION_FAILED',
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
