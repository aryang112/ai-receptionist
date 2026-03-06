// src/services/session.ts
// In-memory conversation session store keyed by Twilio CallSid

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationSession {
  messages: ChatMessage[];
  lastActivity: number; // Date.now()
}

const MAX_TURNS = 8;
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const sessions = new Map<string, ConversationSession>();

export function getSession(callSid: string): ConversationSession {
  let session = sessions.get(callSid);
  if (!session) {
    session = { messages: [], lastActivity: Date.now() };
    sessions.set(callSid, session);
  }
  session.lastActivity = Date.now();
  return session;
}

export function appendToSession(
  callSid: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const session = getSession(callSid);
  session.messages.push({ role, content });

  // Keep only the last MAX_TURNS * 2 messages (each turn = user + assistant)
  if (session.messages.length > MAX_TURNS * 2) {
    session.messages = session.messages.slice(-MAX_TURNS * 2);
  }

  session.lastActivity = Date.now();
}

export function clearSession(callSid: string): void {
  sessions.delete(callSid);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(sid);
    }
  }
}

// Run cleanup on an interval
const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // Don't prevent process exit
