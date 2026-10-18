import { JD_MAX_LENGTH, RESUME_MAX_LENGTH, type InterviewMessage, type InterviewProfile, type InterviewReport } from "../../shared/interview";

export interface PendingAnswer { requestId: string; content: string; timeline: number }
export interface PendingStart { requestId: string; resume: string; jobDescription: string }
export interface SessionCache {
  sessionId: string;
  timeline: number;
  messages: InterviewMessage[];
  pending: PendingAnswer | null;
  draft: string;
  hasInterview: boolean;
  finishRequested: boolean;
  report: InterviewReport | null;
  profile?: InterviewProfile | null;
  setupDraft?: InterviewProfile;
  setupStep?: 1 | 2;
  pendingStart?: PendingStart | null;
}
const KEY = "aiinterview.session.v1";

export function readSessionCache(): SessionCache | null {
  try {
    const serialized = window.desktopSession ? window.desktopSession.read() : localStorage.getItem(KEY);
    const value = JSON.parse(serialized ?? "null");
    if (!value || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.sessionId) ||
        !Array.isArray(value.messages) || !Number.isFinite(value.timeline) || typeof value.draft !== "string") return null;
    // Optional setup fields keep caches from earlier releases readable.
    if (value.setupDraft && (typeof value.setupDraft.resume !== "string" || value.setupDraft.resume.length > RESUME_MAX_LENGTH ||
        typeof value.setupDraft.jobDescription !== "string" || value.setupDraft.jobDescription.length > JD_MAX_LENGTH)) delete value.setupDraft;
    if (value.pendingStart && (typeof value.pendingStart.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.pendingStart.requestId) ||
        typeof value.pendingStart.resume !== "string" || !value.pendingStart.resume.trim() || value.pendingStart.resume.length > RESUME_MAX_LENGTH ||
        typeof value.pendingStart.jobDescription !== "string" || value.pendingStart.jobDescription.length > JD_MAX_LENGTH)) delete value.pendingStart;
    return value as SessionCache;
  } catch { return null; }
}

export function writeSessionCache(value: SessionCache) {
  try {
    const serialized = JSON.stringify(value);
    if (window.desktopSession) window.desktopSession.write(serialized);
    else localStorage.setItem(KEY, serialized);
  } catch { /* Server-side records remain authoritative. */ }
}

export function clearSessionCache() {
  if (window.desktopSession) window.desktopSession.clear();
  localStorage.removeItem(KEY);
}
