import type { ProviderResult, SearchProvider, SearchRequest } from "./types";

export class FakeSearchProvider implements SearchProvider {
  readonly calls: SearchRequest[] = [];
  constructor(private readonly handler: (request: SearchRequest) => Promise<ProviderResult[]> | ProviderResult[]) {}

  async search(request: SearchRequest): Promise<ProviderResult[]> {
    this.calls.push(request);
    return this.handler(request);
  }
}
