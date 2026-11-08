// Public contracts and Zod schemas for Jev browser automation (shared between client and server).
import { z } from "zod";

export const BROWSER_AUTOMATION_STATUSES = [
  "completed",
  "needs-input",
  "needs-agent",
  "interrupted",
  "uncertain",
] as const;
export type BrowserAutomationStatus = (typeof BROWSER_AUTOMATION_STATUSES)[number];

export const BROWSER_FAILURE_REASONS = [
  "disabled",
  "not-ready",
  "unsupported-observation",
  "sensitive-page",
  "state-too-large",
  "no-candidates",
  "invalid-decision",
  "low-confidence",
  "needs-text",
  "stale-text",
  "stale-observation",
  "permission-required",
  "permission-denied",
  "human-control",
  "cancelled",
  "scope-changed",
  "model-unavailable",
  "budget",
  "no-progress",
  "human-only",
  "unknown-outcome",
  "post-observation-failed",
  "expectation-unmet",
  "done-unverified",
  "blocked",
  "text-model-failed",
] as const;
export type BrowserFailureReason = (typeof BROWSER_FAILURE_REASONS)[number];

export const browserVisibleTextExpectationSchema = z.strictObject({
  kind: z.literal("visible-text"),
  text: z.string().trim().min(1).max(2000),
});

export const browserUrlPathExpectationSchema = z.strictObject({
  kind: z.literal("url-path"),
  origin: z.string().trim().min(1).max(1024),
  pathname: z.string().trim().min(1).max(1024),
});

export const browserFieldStateExpectationSchema = z.strictObject({
  kind: z.literal("field-state"),
  label: z.string().trim().min(1).max(256),
  role: z.string().trim().min(1).max(64),
  value: z.string().max(2000).optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
}).refine(
  (data) => data.value !== undefined || data.checked !== undefined || data.selected !== undefined,
  "field-state expectation requires at least one of value, checked, or selected",
);

export const browserExpectationSchema = z.discriminatedUnion("kind", [
  browserVisibleTextExpectationSchema,
  browserUrlPathExpectationSchema,
  browserFieldStateExpectationSchema,
]);
export type BrowserExpectation = z.infer<typeof browserExpectationSchema>;

export const browserTextReplySchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  value: z.strictObject({
    text: z.string().max(2000).nullable(),
  }),
});
export type BrowserTextReply = z.infer<typeof browserTextReplySchema>;

export const browserPendingFieldSchema = z.strictObject({
  requestId: z.string(),
  field: z.strictObject({
    label: z.string(),
    role: z.string(),
  }),
  context: z.strictObject({
    goal: z.string(),
    field: z.strictObject({
      label: z.string(),
      role: z.string(),
    }),
    page: z.strictObject({
      title: z.string(),
      origin: z.string(),
    }),
    recentActions: z.array(z.string()),
  }),
  instruction: z.string(),
});
export type BrowserPendingField = z.infer<typeof browserPendingFieldSchema>;

export const browserStepSummarySchema = z.strictObject({
  stepNumber: z.number().int().positive().optional(),
  action: z.string(),
  state: z.enum(["completed", "not-dispatched", "unknown"]),
  details: z.string().optional(),
});
export type BrowserStepSummary = z.infer<typeof browserStepSummarySchema>;

export const browserLastObservationSchema = z.strictObject({
  title: z.string(),
  origin: z.string(),
  stateText: z.string(),
  candidateCount: z.number().int().nonnegative(),
});
export type BrowserLastObservation = z.infer<typeof browserLastObservationSchema>;

export const browserRunInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(2000),
  tab: z.string().trim().min(1).max(128).optional(),
  maxSteps: z.number().int().min(1).max(8).default(4),
  textReply: browserTextReplySchema.optional(),
  expect: z
    .strictObject({
      all: z.array(browserExpectationSchema).min(1).max(8),
    })
    .optional(),
});
export type BrowserRunInput = z.infer<typeof browserRunInputSchema>;

export const browserRunResultSchema = z.strictObject({
  status: z.enum(BROWSER_AUTOMATION_STATUSES),
  steps: z.array(browserStepSummarySchema),
  lastObservation: browserLastObservationSchema.optional(),
  reason: z.enum(BROWSER_FAILURE_REASONS).optional(),
  pendingField: browserPendingFieldSchema.optional(),
});
export type BrowserRunResult = z.infer<typeof browserRunResultSchema>;
