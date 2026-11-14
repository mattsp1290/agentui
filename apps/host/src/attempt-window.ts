export class AttemptWindow {
  private readonly sources = new Map<string, { readonly start: number; failures: number }>();
  fail(source: string, now: number): void {
    for (const [key, window] of this.sources) if (now - window.start >= 60_000) this.sources.delete(key);
    let window = this.sources.get(source);
    if (!window) {
      if (this.sources.size >= 64) throw new Error('Pairing attempt limit');
      window = { start: now, failures: 0 };
      this.sources.set(source, window);
    }
    if (++window.failures > 20) throw new Error('Pairing attempt limit');
  }
}
