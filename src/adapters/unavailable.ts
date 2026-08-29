import type { AdapterCollection, CollectionContext, MetricsAdapter, Platform } from "../types.js";
export class UnavailableAdapter implements MetricsAdapter {
  constructor(readonly platform: Platform, private readonly reason: string) {}
  async collect(_context: CollectionContext): Promise<AdapterCollection> { throw new Error(this.reason); }
}
export function initializeAdapter(platform: Platform, factory: () => MetricsAdapter): MetricsAdapter {
  try { return factory(); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new UnavailableAdapter(platform, `${platform} adapter configuration failed: ${detail}`);
  }
}
export async function initializeAdapterAsync(platform: Platform, factory: () => Promise<MetricsAdapter>): Promise<MetricsAdapter> {
  try { return await factory(); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new UnavailableAdapter(platform, `${platform} adapter configuration failed: ${detail}`);
  }
}
