import { RunAgentInputSchema, ToolSchema } from '@ag-ui/core/schemas';
import { canonicalJson, copyJson } from '@agentui/contracts';
import type { ClientCommand, FrontendOffer, Json } from '@agentui/contracts';
import type { ProviderTarget } from './provider-commands.js';
import { identifier, record } from '@agentui/contracts/decode';

export function aguiInput(value: unknown): ReturnType<typeof RunAgentInputSchema.parse> {
  const parsed = RunAgentInputSchema.parse(value);
  identifier(parsed.runId); identifier(parsed.threadId);
  const names = new Set<string>();
  for (const tool of parsed.tools ?? []) {
    if (names.has(tool.name)) throw new Error('Duplicate AG-UI tool');
    names.add(tool.name);
  }
  return parsed;
}
export function offerInput(value: Json, offer: FrontendOffer): Json {
  const input = aguiInput(value), raw = record(value);
  const tools = input.tools ?? [], names = new Set(tools.map(tool => tool.name));
  for (const { definition } of offer.tools) {
    ToolSchema.parse(definition);
    if (names.has(definition.name)) throw new Error('Frontend tool collision');
    names.add(definition.name);
  }
  return copyJson({ ...raw, tools: [...(Array.isArray(raw.tools) ? raw.tools : []), ...offer.tools.map(tool => tool.definition)] });
}
export function matchOfferInput(value: unknown, offer: FrontendOffer): ReturnType<typeof RunAgentInputSchema.parse> {
  const input = aguiInput(value), raw = record(value);
  if (!Array.isArray(raw.tools) || canonicalJson(raw.tools.slice(-offer.tools.length)) !== canonicalJson(offer.tools.map(tool => tool.definition))) throw new Error('Frontend offer changed');
  return input;
}

export function legacyOfferedRunId(command: ClientCommand, target: ProviderTarget): string | undefined {
  if (command.version !== 2) return undefined;
  if (target.operation.kind !== 'send') throw new Error('Invalid offered command target');
  return target.operation.protocol === 'ag-ui' ? undefined : matchOfferInput(target.operation.request, command.body.frontend).runId;
}
