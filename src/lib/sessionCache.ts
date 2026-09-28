import type { InterviewMessage, InterviewReport } from "../../shared/interview";

export interface PendingAnswer { requestId: string; content: string; timeline: number }
export interface SessionCache {
  sessionId: string;
  timeline: number;
  messages: InterviewMessage[];
  pending: PendingAnswer | null;
  draft: string;
  hasInterview: boolean;
  finishRequested: boolean;
  report: InterviewReport | null;
}
const KEY = "aiinterview.session.v1";

export function readSessionCache(): SessionCache | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.sessionId) ||
        !Array.isArray(value.messages) || !Number.isFinite(value.timeline) || typeof value.draft !== "string") return null;
    return value as SessionCache;
  } catch { return null; }
}

export function writeSessionCache(value: SessionCache) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Server-side records remain authoritative. */ }
}

export function clearSessionCache() { localStorage.removeItem(KEY); }
