export const INTERVIEW_DURATION_MINUTES = 32;
export const RESUME_MAX_LENGTH = 20_000;
export const JD_MAX_LENGTH = 10_000;

export interface InterviewProfile {
  resume: string;
  jobDescription: string;
}

export interface InterviewMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export const FEEDBACK_DIMENSIONS = [
  { id: "technical", title: "技术基础" },
  { id: "project", title: "项目深度" },
  { id: "reasoning", title: "问题分析" },
  { id: "communication", title: "表达沟通" },
] as const;

export type FeedbackLevel = "strong" | "developing" | "needs_work" | "not_covered";

export interface FeedbackDimension {
  id: (typeof FEEDBACK_DIMENSIONS)[number]["id"];
  title: string;
  level: FeedbackLevel;
  assessment: string;
  strengths: string[];
  improvements: string[];
  evidence: Array<{ messageId: string; quote: string }>;
}

export interface InterviewFeedback {
  summary: string;
  dimensions: FeedbackDimension[];
}

export interface InterviewReport extends InterviewFeedback {
  sessionId: string;
  generatedAt: number;
  durationMinutes: number;
  messages: InterviewMessage[];
  profile?: InterviewProfile;
}

export interface InterviewTurn {
  requestId: string;
  kind?: "opening" | "answer";
  userMessageId?: string;
  assistantMessageId: string;
  status: "pending" | "completed" | "failed";
  channel?: string;
}

export interface InterviewSessionView {
  sessionId: string;
  messages: InterviewMessage[];
  timeline: number;
  status: "active" | "finishing" | "finished" | "report_error";
  lastTurn?: InterviewTurn;
  report?: InterviewReport;
  profile?: InterviewProfile;
}
