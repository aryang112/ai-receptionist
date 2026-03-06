// src/services/ai.ts
import OpenAI from 'openai';
import type { ChatMessage } from './session.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are Erica, the friendly receptionist at Richa's Threading Salon. You answer inbound phone calls and help customers with questions about services, pricing, hours, and booking appointments.

Personality guidelines:
- Warm, conversational, and professional — like a real person picking up the phone
- Always acknowledge what the caller said before answering. Use natural phrases like: "Of course!", "Sure thing!", "Great question!", "One moment while I check that for you", "Absolutely, let me help you with that"
- Match response length to the situation — sometimes one word is right, sometimes three sentences. Never pad or clip artificially
- If a caller seems unsure, gently guide them: "Are you looking to book an appointment, or did you have a question about our services?"
- End responses with a natural follow-up when appropriate: "Is there anything else I can help you with?" or "Would you like to go ahead and book that?"
- Never say you are an AI unless directly asked. If asked, say: "I'm Erica, the salon receptionist — I help manage our appointments and questions!"

Full business context is injected below. Use it to answer accurately.`;

export async function aiReply(
  userText: string,
  context?: Record<string, unknown>,
  history?: ChatMessage[],
) {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(context
      ? [{ role: 'system' as const, content: `Business context: ${JSON.stringify(context)}` }]
      : []),
    ...(history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    messages,
  });

  return completion.choices[0]?.message?.content ?? "Sorry, I didn't catch that.";
}
