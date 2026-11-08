// The legacy check-in tests were written against node:test + node:assert/strict.
// These aliases let them move to vitest with their bodies unchanged.
import { afterAll, expect, it, onTestFinished, vi } from "vitest";

interface TestContext {
  after(callback: () => unknown): void;
  diagnostic(message: string): void;
  mock: {
    method(target: Record<string | symbol, unknown>, key: string, implementation: (...args: never[]) => unknown): unknown;
  };
}

type TestBody = (context: TestContext) => unknown;

function run(name: string, body: TestBody): void {
  void it(name, async () => {
    const spies: Array<{ mockRestore(): void }> = [];
    try {
      await body({
        after: (callback) => onTestFinished(callback),
        diagnostic: (message) => console.info(message),
        mock: {
          method(target, key, implementation) {
            const spy = vi.spyOn(target as never, key as never).mockImplementation(implementation as never);
            spies.push(spy as unknown as { mockRestore(): void });
            return spy;
          },
        },
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}

export const test = Object.assign(run, {
  after: (callback: () => unknown) => afterAll(callback),
});

type Matcher = RegExp | string;

export const assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toEqual(expected);
  },
  ok(value: unknown, message?: string): void {
    expect(value, message).toBeTruthy();
  },
  match(value: string, matcher: Matcher, message?: string): void {
    expect(value, message).toMatch(matcher);
  },
  throws(fn: () => unknown, matcher?: Matcher, message?: string): void {
    expect(fn, message).toThrow(matcher);
  },
};
