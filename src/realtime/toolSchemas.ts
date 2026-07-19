import { z } from 'zod';

/**
 * Zod schemas mirroring TOOL_DEFINITIONS in twilioStream.ts — one per tool.
 * These give other agents a way to validate the arguments the model emits for a
 * tool call before executing it. Required/optional fields match the OpenAI tool
 * definitions exactly; permissive tools (no required fields) validate loosely.
 */
export const TOOL_SCHEMAS = {
  suggest_availability: z.object({
    serviceName: z.string(),
    date: z.string(),
    preferredTime: z.string().optional(),
  }),
  book_appointment: z.object({
    serviceName: z.string(),
    date: z.string(),
    time: z.string(),
    // Optional: when a recognized/known caller is booked we pass their real
    // clientId and skip phone-based resolution (CT-1). MUST mirror
    // TOOL_DEFINITIONS — zod strip-mode silently DELETES unlisted keys, which
    // previously dropped clientId at the validation seam and re-broke CT-1.
    clientId: z.string().optional(),
    customer: z.object({
      name: z.string(),
      // Optional: a name-identified caller can be booked without a phone
      // (their clientId carries identity). Required-phone forced fabrication.
      phone: z.string().optional(),
      email: z.string().optional(),
    }),
  }),
  reschedule_appointment: z.object({
    appointmentId: z.string(),
    date: z.string(),
    time: z.string(),
  }),
  cancel_appointment: z.object({
    appointmentId: z.string(),
  }),
  get_business_hours: z.object({}),
  get_prices: z.object({
    serviceName: z.string().optional(),
  }),
  lookup_customer: z.object({
    phone: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }),
  list_appointments: z.object({
    clientId: z.string(),
  }),
  log_running_late: z.object({
    clientId: z.string(),
    appointmentId: z.string(),
  }),
  transfer_to_owner: z.object({
    reason: z.string(),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export type ParseToolArgsResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * Validate a tool's arguments against its schema. Returns the parsed data on
 * success, or a short human-readable error joining the zod issues on failure.
 */
export function parseToolArgs(
  name: string,
  args: unknown
): ParseToolArgsResult {
  const schema = TOOL_SCHEMAS[name as ToolName];
  if (!schema) return { success: false, error: `Unknown tool: ${name}` };

  const result = schema.safeParse(args);
  if (result.success) return { success: true, data: result.data };

  const error = result.error.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
  return { success: false, error };
}
