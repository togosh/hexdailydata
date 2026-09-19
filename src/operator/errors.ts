/** Parsers and OS/SQL errors can echo supplied bytes or paths. Operator errors keep
 * a useful category without serializing payloads, connection settings or stderr. */
export function operatorError(error: unknown) {
  if (!(error instanceof Error)) return 'Operation failed.';
  if (error instanceof SyntaxError || error.name === 'ZodError')
    return 'Invalid operator input or incompatible manifest.';
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string')
    return /^[A-Z0-9_]{2,40}$/.test(code)
      ? `Operation rejected (${code}).`
      : 'Dependency rejected operation.';
  return error.message.slice(0, 300);
}
