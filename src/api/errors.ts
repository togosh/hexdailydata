export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const unavailable = () =>
  new ApiFailure(503, 'source_unavailable', 'Required data is unavailable.');
export const restart = () =>
  new ApiFailure(409, 'cursor_incompatible', 'Observation changed or expired; restart pagination.');
