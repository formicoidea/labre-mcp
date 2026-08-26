// The seam, pinned (CH-23 / ARCH-27, third cut): the auth nature stops at the
// dispatch. A tool handler — and therefore every listener and strategy below
// it — receives the BUSINESS context only.
//
// This is the test that would have caught the old shape: pre-CH-23 a verified
// user JWT rode on `context.auth.token` all the way into strategy code, and
// nothing said it must not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "#core/registry/tool-registry.mjs";
import type { RequestContext } from "#core/context/request-context.mjs";
import { dispatch } from "./mcp-handler.mjs";
import { toBusinessContext, withAuth, type AuthenticatedContext } from "./auth-context.mjs";
import { extractContext } from "./context-extractor.mjs";

const BUSINESS: RequestContext = {
  projectId: "p",
  projectRoot: "/tmp/p",
  sessionId: "s",
  domain: "wardley",
};

/** A registry holding one tool that records the context it was handed. */
function spyRegistry(): { tools: ToolRegistry; seen: () => unknown } {
  let captured: unknown;
  const tools = new ToolRegistry();
  tools.register({
    name: "spy",
    description: "records the context it receives",
    inputSchema: { type: "object" },
    async handler(_args, context) {
      captured = context;
      return { ok: true };
    },
  });
  return { tools, seen: () => captured };
}

describe("withAuth — the two natures are stamped together", () => {
  it("puts the opaque id on the business context and the credential beside it", () => {
    const authed = withAuth(BUSINESS, {
      userId: "u-1",
      role: "authenticated",
      token: "a.real.jwt",
      source: "supabase",
    });
    assert.equal(authed.userId, "u-1");
    assert.equal(authed.auth?.token, "a.real.jwt");
    assert.equal(authed.auth?.source, "supabase");
    // They cannot drift: withAuth is the only writer of both.
    assert.equal(authed.userId, authed.auth?.userId);
  });
});

describe("toBusinessContext — the auth nature is dropped", () => {
  it("keeps userId and removes the credential entirely", () => {
    const business = toBusinessContext(
      withAuth(BUSINESS, { userId: "u-1", token: "a.real.jwt", source: "oidc" }),
    );
    assert.equal(business.userId, "u-1");
    assert.equal("auth" in business, false);
    assert.equal(JSON.stringify(business).includes("a.real.jwt"), false);
  });
});

describe("dispatch — the seam", () => {
  it("hands the handler the business context, never the credential", async () => {
    const { tools, seen } = spyRegistry();
    const authed: AuthenticatedContext = withAuth(BUSINESS, {
      userId: "u-42",
      token: "secret.bearer.value",
      source: "supabase",
    });

    await dispatch({
      request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spy" } },
      context: authed,
      tools,
    });

    const received = seen() as Record<string, unknown>;
    assert.equal(received.projectId, "p");
    assert.equal(received.userId, "u-42", "minimal identity must survive — quota/RLS need it");
    assert.equal("auth" in received, false, "the auth nature must not cross the dispatch");
    assert.equal(JSON.stringify(received).includes("secret.bearer.value"), false);
  });
});

describe("extractContext — a caller cannot assert its own identity", () => {
  it("drops a client-supplied userId", () => {
    const context = extractContext({
      _context: { ...BUSINESS, userId: "someone-elses-id" },
    });
    assert.equal(context.projectId, "p", "the business fields are still honoured");
    assert.equal(context.userId, undefined, "identity comes from the auth door only");
  });

  it("drops a client-supplied auth object (it is not part of the business schema)", () => {
    const context = extractContext({
      _context: { ...BUSINESS, auth: { userId: "forged", token: "forged.jwt" } },
    }) as Record<string, unknown>;
    assert.equal("auth" in context, false);
  });
});
