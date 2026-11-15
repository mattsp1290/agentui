export function nativeProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('OTEL_') && name !== 'AGENTUI_DATADOG_LLMOBS'));
}
