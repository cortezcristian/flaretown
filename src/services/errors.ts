// Errors raised by the service layer. REST and MCP turn them into { error, code, hint }.
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly status = 400,
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.message, code: this.code, hint: this.hint };
  }
}
