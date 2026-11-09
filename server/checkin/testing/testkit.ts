// The legacy check-in tests were written against node:test + node:assert/strict.
// These aliases let them move to vitest with their bodies unchanged.
import { afterAll, expect, it, onTestFinished, vi } from "vitest";

interface TestContext {
  after(callback: () => void | Promise<void>): void;
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
            const spy = vi
              .spyOn(target as Record<string | symbol, (...args: never[]) => unknown>, key as string | symbol)
              .mockImplementation(implementation);
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

// 显式标注让 assert.ok 成为可窄化的断言函数（TS2775 要求调用目标有显式类型）。
interface Assert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): asserts value;
  match(value: string, matcher: Matcher, message?: string): void;
  throws(fn: () => unknown, matcher?: Matcher, message?: string): void;
}

export const assert: Assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toEqual(expected);
  },
  ok(value: unknown, message?: string): asserts value {
    expect(value, message).toBeTruthy();
  },
  match(value: string, matcher: Matcher, message?: string): void {
    expect(value, message).toMatch(matcher);
  },
  throws(fn: () => unknown, matcher?: Matcher, message?: string): void {
    expect(fn, message).toThrow(matcher);
  },
};
