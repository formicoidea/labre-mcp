import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCopilotSdkTextCall,
  createCopilotSdkStructuredCall,
  interpolate,
} from './copilot-sdk-call.mjs';

describe('copilot-sdk-call / interpolate', () => {
  it('substitutes {{variable}} placeholders', () => {
    assert.equal(
      interpolate('Hello {{name}}', { name: 'world' }),
      'Hello world',
    );
  });

  it('leaves unknown placeholders untouched', () => {
    assert.equal(interpolate('Hello {{missing}}', {}), 'Hello {{missing}}');
  });

  it('returns the template unchanged when no variables are supplied', () => {
    assert.equal(interpolate('plain text'), 'plain text');
  });
});

describe('createCopilotSdkTextCall', () => {
  it('returns a callable LLMCall', () => {
    const call = createCopilotSdkTextCall({ model: 'gpt-5' });
    assert.equal(typeof call, 'function');
  });

  it('accepts an empty config (defaults apply)', () => {
    const call = createCopilotSdkTextCall();
    assert.equal(typeof call, 'function');
  });

  it('accepts a systemPrompt', () => {
    const call = createCopilotSdkTextCall({
      model: 'gpt-5',
      systemPrompt: 'You are a terse assistant.',
    });
    assert.equal(typeof call, 'function');
  });
});

describe('createCopilotSdkStructuredCall', () => {
  const schema = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };

  it('returns a callable StructuredLLMCall', () => {
    const call = createCopilotSdkStructuredCall({ schema, model: 'gpt-5' });
    assert.equal(typeof call, 'function');
  });

  it('throws when no schema is provided', () => {
    assert.throws(
      // any: intentional misuse to verify runtime guard
      () => createCopilotSdkStructuredCall({} as any),
      /requires a schema/,
    );
  });

  it('accepts a custom validate function', () => {
    const call = createCopilotSdkStructuredCall({
      schema,
      model: 'gpt-5',
      validate: (v) => {
        if (typeof (v as { answer?: unknown })?.answer !== 'string') {
          throw new Error('answer must be a string');
        }
        return v as { answer: string };
      },
    });
    assert.equal(typeof call, 'function');
  });
});
