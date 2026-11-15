import type { SecretProvider } from '@agentui/sdk';

export function secretResolver({ provider, reference }: {
  readonly provider: SecretProvider;
  readonly reference: string;
}): () => Promise<string> {
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('Secret resolution refused');
  return async () => {
    try {
      const secret = await provider.resolve(reference);
      if (typeof secret !== 'string' || !secret.trim()) throw new Error('Secret resolution refused');
      return secret;
    } catch { throw new Error('Secret resolution refused'); }
  };
}
