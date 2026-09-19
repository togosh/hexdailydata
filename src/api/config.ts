export function developmentConfig(env: NodeJS.ProcessEnv) {
  if (
    (env.HDD_V2_MODE && env.HDD_V2_MODE !== 'development') ||
    (env.HDD_V2_ALLOW_LIVE_RPC && env.HDD_V2_ALLOW_LIVE_RPC !== 'false')
  ) {
    throw new Error('Only development mode with live providers disabled is implemented.');
  }
  const rawPort = env.HDD_V2_HTTP_PORT ?? '4320';
  if (!/^(0|[1-9][0-9]{0,4})$/.test(rawPort) || Number(rawPort) > 65_535) {
    throw new Error('Invalid HTTP port.');
  }
  const host = env.HDD_V2_HTTP_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host))
    throw new Error('Invalid development bind host.');
  return { port: Number(rawPort), host };
}
