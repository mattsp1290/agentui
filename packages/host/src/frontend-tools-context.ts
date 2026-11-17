import type { ConversationScope } from '@agentui/contracts';
import type { SqliteStore } from './sqlite-store.js';

type Context = Pick<SqliteStore<unknown, unknown>, 'db' | 'transaction' | 'findInstallation' | 'frontendSends'> & {
  readonly authorized: (scope: ConversationScope) => ConversationScope;
};
const contexts = new WeakMap<object, Context>();
export function registerFrontendToolsHost(host: object, context: Context): void {
  contexts.set(host, context);
}
export function frontendToolsContext(host: object): Context {
  const context = contexts.get(host);
  if (!context) throw new Error('Frontend tools require an openLocalHost handle');
  return context;
}
