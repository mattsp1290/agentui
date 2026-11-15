import { CustomizationError } from './contract.js';

export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export class SourceBudget {
  static snapshot(): SourceBudget { return new SourceBudget(20_000, Infinity, Date.now); }
  static graph(now = Date.now): SourceBudget { return new SourceBudget(50_000, now() + 600_000, now); }
  private bytes = MAX_SOURCE_BYTES;
  private constructor(private files: number, private readonly deadline: number, private readonly now: () => number) {}
  check(): void { this.timeout(Infinity); }
  timeout(cap: number): number {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw new CustomizationError('resource-limit', 'Customization source deadline exceeded.');
    return Math.max(1, Math.min(cap, remaining));
  }
  takeFiles(count: number): void {
    this.files -= count;
    if (this.files < 0) throw new CustomizationError('resource-limit', 'Customization source file limit exceeded.');
  }
  takeBytes(count: number): void {
    this.bytes -= count;
    if (this.bytes < 0) throw new CustomizationError('resource-limit', 'Customization source byte limit exceeded.');
  }
}
