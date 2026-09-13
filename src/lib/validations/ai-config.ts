import { z } from "zod";

export const aiConfigSchema = z.object({
  tone: z.enum(["FORMAL", "CERCANO"]),
  useEmojis: z.boolean(),
  additionalInstructions: z.string().trim().max(4000).optional().or(z.literal("")),
});

export type AiConfigInput = z.infer<typeof aiConfigSchema>;

export const testConversationSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40),
});
