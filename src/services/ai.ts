// src/services/ai.ts
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function aiReply(userText: string, context?: Record<string, unknown>) {
  const systemText =
    `You are Erica, a warm, concise receptionist for Richa's Threading Salon.
     You can answer prices, hours, and help book/reschedule/cancel.
     Keep replies under 2 sentences unless asked for details.`;

  const messages = [
    { role: 'system' as const, content: systemText },
    ...(context ? [{ role: 'system' as const, content: `Context: ${JSON.stringify(context)}` }] : []),
    { role: 'user' as const, content: userText }
  ];

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    messages
  });

  return completion.choices[0]?.message?.content ?? "Sorry, I didn't catch that.";
}
