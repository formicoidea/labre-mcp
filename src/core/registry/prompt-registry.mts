// The kernel's PROMPT REGISTRY — the seam through which a delivery layer hands
// a set of METHOD prompts to a transport (CH-24, ARCH-28).
//
// WHY IT MIRRORS ToolRegistry. The façade (ARCH-27) states the rule: the kernel
// owns the registry CONTRACT, the delivery layer (`src/mcp/`) composes ITS
// entries into an instance, and the transport receives that instance already
// filled and never names one. A prompt surface is exactly another such
// registry, so it is exactly the same shape — see tool-registry.mts for the
// reasoning that is not repeated here.
//
// WHAT IT IS NOT. This is not an MCP type. A `PromptDefinition` is a named,
// documented piece of TEXT with declared arguments and a pure `render()` that
// substitutes them. There is no JSON-RPC in it, no `prompts/get` shaping, and
// above all no executable payload: the costume is DATA (ARCH-28). Rendering is
// string substitution over text this repository ships — nothing is loaded at
// run time, and a prompt can neither call a strategy nor reach the network.
// Serving it over MCP is the transport's job.

/** One declared argument of a prompt — mirrors the prompt's own variables. */
export interface PromptArgumentDefinition {
  name: string;
  description: string;
  /** A required argument with no value supplied makes `render()` throw. */
  required: boolean;
}

/** One rendered message. MCP prompt messages carry no `system` role, so a
 *  prompt whose method lives in an invariant system half emits it as the FIRST
 *  user message — see the MCP delivery for that translation. */
export interface PromptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface PromptDefinition {
  /** Stable id, unique in the registry. Kept to `^[a-zA-Z0-9_-]{1,64}$` by the
   *  delivery layer for the same reason tool names are (hard rule #24b). */
  name: string;
  /** Human title, shown by clients that render a prompt picker. */
  title: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  /** Pure text substitution. Throws on a missing required argument. */
  render: (args: Record<string, string>) => PromptMessage[];
}

/** What `list()` returns: everything but the renderer. */
export type PromptSummary = Omit<PromptDefinition, "render">;

export class PromptRegistry {
  private readonly map = new Map<string, PromptDefinition>();

  register(prompt: PromptDefinition): void {
    if (this.map.has(prompt.name)) {
      throw new Error(`Prompt "${prompt.name}" already registered`);
    }
    this.map.set(prompt.name, prompt);
  }

  /** Registered prompts, sorted by name so the wire order is stable. */
  list(): PromptSummary[] {
    return [...this.map.values()]
      .map(({ name, title, description, arguments: args }) => ({
        name,
        title,
        description,
        arguments: args,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): PromptDefinition | undefined {
    return this.map.get(name);
  }

  size(): number {
    return this.map.size;
  }
}

/**
 * Render helper shared by every prompt the delivery composes: enforce the
 * declared required arguments, then substitute. Declared HERE rather than in
 * each entry so "required" means one thing across the whole surface.
 */
export function requireArguments(
  promptName: string,
  declared: PromptArgumentDefinition[],
  args: Record<string, string>,
): void {
  const missing = declared
    .filter((a) => a.required)
    .map((a) => a.name)
    .filter((name) => {
      const value = args[name];
      return value === undefined || value === null || value === "";
    });
  if (missing.length > 0) {
    throw new Error(
      `Prompt "${promptName}" requires argument(s) ${JSON.stringify(missing)} (declared in its arguments[])`,
    );
  }
}
