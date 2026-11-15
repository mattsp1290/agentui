import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { identifier, record, exact } from '@agentui/contracts/decode';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import type { ClaudeSdkModel } from '@agentui/contracts/compatibility';
import { codexInstallation, codexSdkInstallation, claudeSdkInstallation, piInstallation } from '@agentui/host';

export type NativeProvider =
  | { readonly kind: 'codex' | 'codex-sdk'; readonly cwd: string; readonly executable?: string }
  | { readonly kind: 'claude-sdk'; readonly cwd: string; readonly model: ClaudeSdkModel; readonly executable?: string }
  | { readonly kind: 'pi'; readonly cwd: string };
export interface AgentConfiguration {
  readonly default: string;
  readonly agents: readonly (NativeProvider & { readonly name: string })[];
}
export function providerInstallation(provider: NativeProvider) {
  switch (provider.kind) {
    case 'codex': return codexInstallation(provider.cwd, CODEX_RUNTIME.version);
    case 'codex-sdk': return codexSdkInstallation(provider.cwd);
    case 'claude-sdk': return claudeSdkInstallation(provider.cwd, provider.model);
    case 'pi': return piInstallation(provider.cwd);
  }
}
export function readAgentConfiguration(path: string): AgentConfiguration {
  const input = record(JSON.parse(readFileSync(path, 'utf8')), ['version', 'default', 'agents']);
  if (input.version !== 1 || !Array.isArray(input.agents) || !input.agents.length) throw new Error('Expected version 1 with at least one agent');
  const agents = input.agents.map((value: unknown): NativeProvider & { readonly name: string } => {
    const entry = record(value);
    const fields = ['name', 'kind', 'workspace', ...(entry.kind === 'claude-sdk' ? ['model'] : []),
      ...(entry.kind !== 'pi' && Object.hasOwn(entry, 'executable') ? ['executable'] : [])];
    exact(entry, fields);
    const base = { name: identifier(entry.name), cwd: resolve(identifier(entry.workspace)) };
    const executable = Object.hasOwn(entry, 'executable') ? { executable: resolve(identifier(entry.executable)) } : {};
    switch (entry.kind) {
      case 'codex': case 'codex-sdk': return { ...base, kind: entry.kind, ...executable };
      case 'claude-sdk':
        if (entry.model !== 'opus' && entry.model !== 'sonnet') throw new Error('Claude model must be opus or sonnet');
        return { ...base, kind: entry.kind, model: entry.model, ...executable };
      case 'pi': return { ...base, kind: entry.kind };
      default: throw new Error('Unsupported native agent kind');
    }
  });
  const selected = identifier(input.default);
  if (new Set(agents.map(agent => agent.name)).size !== agents.length || !agents.some(agent => agent.name === selected)) throw new Error('Agent names must be unique and include the configured default');
  return { default: selected, agents };
}
