export interface SecretProvider {
  readonly resolve: (reference: string) => Promise<string>;
}
