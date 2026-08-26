// The kernel's RESOURCE REGISTRY — the seam through which a delivery layer
// hands a set of readable KNOWLEDGE documents to a transport (CH-24, ARCH-28).
//
// Same shape and same reasoning as tool-registry.mts and prompt-registry.mts:
// the kernel owns the contract, `src/mcp/` composes the entries, the transport
// serves whatever it is handed and names none of them.
//
// WHAT A RESOURCE IS. A stable URI, a mime type, and a `read()` that returns
// TEXT. `read()` is async because two of the shipped categories come off disk
// (the JSON Schemas, the shipped recipes) — it is never a computation a caller
// can steer: no argument reaches it. That is the DATA-ONLY limit of ARCH-28
// stated as a type; a resource that took parameters would be a tool wearing a
// URI.

export interface ResourceDefinition {
  /** Stable URI under the `labre://` scheme — see ARCH-28 for the scheme. */
  uri: string;
  /** Short machine-ish name, unique in the registry. */
  name: string;
  /** Human title, shown by clients that render a resource picker. */
  title: string;
  description: string;
  mimeType: string;
  /** Read the document. Takes NO argument, by contract (see header). */
  read: () => Promise<string>;
}

/** What `list()` returns: everything but the reader. */
export type ResourceSummary = Omit<ResourceDefinition, "read">;

export class ResourceRegistry {
  private readonly map = new Map<string, ResourceDefinition>();

  register(resource: ResourceDefinition): void {
    if (this.map.has(resource.uri)) {
      throw new Error(`Resource "${resource.uri}" already registered`);
    }
    this.map.set(resource.uri, resource);
  }

  /** Registered resources, sorted by URI so the wire order is stable. */
  list(): ResourceSummary[] {
    return [...this.map.values()]
      .map(({ uri, name, title, description, mimeType }) => ({
        uri,
        name,
        title,
        description,
        mimeType,
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  get(uri: string): ResourceDefinition | undefined {
    return this.map.get(uri);
  }

  size(): number {
    return this.map.size;
  }
}
