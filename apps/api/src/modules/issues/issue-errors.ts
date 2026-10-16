export class IssueError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}
