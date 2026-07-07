import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithPromptOverrides,
  getCurrentPromptOverrides,
  type PromptOverrideStore,
} from './override-context.mjs';

function storeWith(user: string): PromptOverrideStore {
  return { prompts: { s: { default: { system: 'sys', user } } } };
}

describe('override-context — AsyncLocalStorage store', () => {
  it('exposes the store synchronously inside the run', () => {
    const store = storeWith('u');
    runWithPromptOverrides(store, () => {
      assert.strictEqual(getCurrentPromptOverrides(), store);
    });
  });

  it('keeps the store visible across an await boundary', async () => {
    const store = storeWith('u');
    await runWithPromptOverrides(store, async () => {
      await Promise.resolve();
      assert.strictEqual(getCurrentPromptOverrides(), store);
    });
  });

  it('returns undefined outside any run', () => {
    assert.equal(getCurrentPromptOverrides(), undefined);
  });

  it('returns undefined again after the run completes', async () => {
    await runWithPromptOverrides(storeWith('u'), async () => {
      await Promise.resolve();
    });
    assert.equal(getCurrentPromptOverrides(), undefined);
  });

  it('isolates nested runs (inner shadows outer, outer restored after)', () => {
    const outer = storeWith('outer');
    const inner = storeWith('inner');
    runWithPromptOverrides(outer, () => {
      assert.strictEqual(getCurrentPromptOverrides(), outer);
      runWithPromptOverrides(inner, () => {
        assert.strictEqual(getCurrentPromptOverrides(), inner);
      });
      assert.strictEqual(getCurrentPromptOverrides(), outer);
    });
  });

  it('isolates two concurrent runs — each sees its own store', async () => {
    const a = storeWith('a');
    const b = storeWith('b');

    const runA = runWithPromptOverrides(a, async () => {
      await Promise.resolve();
      assert.strictEqual(getCurrentPromptOverrides(), a);
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(getCurrentPromptOverrides(), a);
      return 'a';
    });
    const runB = runWithPromptOverrides(b, async () => {
      await Promise.resolve();
      assert.strictEqual(getCurrentPromptOverrides(), b);
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(getCurrentPromptOverrides(), b);
      return 'b';
    });

    const [ra, rb] = await Promise.all([runA, runB]);
    assert.equal(ra, 'a');
    assert.equal(rb, 'b');
    assert.equal(getCurrentPromptOverrides(), undefined);
  });
});
