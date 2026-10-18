import { JD_MAX_LENGTH, RESUME_MAX_LENGTH, type InterviewProfile } from "../../../shared/interview";
import defaultJobDescription from "../prompt/jd.prompt";

export class ProfileInputError extends Error {}

export function normalizeInterviewProfile(resume: unknown, jobDescription?: unknown): InterviewProfile {
  if (typeof resume !== "string" || !resume.trim() || resume.length > RESUME_MAX_LENGTH) {
    throw new ProfileInputError(`请填写简历内容，最多 ${RESUME_MAX_LENGTH.toLocaleString("en-US")} 字符`);
  }
  if (jobDescription !== undefined && (typeof jobDescription !== "string" || jobDescription.length > JD_MAX_LENGTH)) {
    throw new ProfileInputError(`职位 JD 必须是文本，最多 ${JD_MAX_LENGTH.toLocaleString("en-US")} 字符`);
  }
  return { resume: resume.trim(), jobDescription: (jobDescription as string | undefined)?.trim() || defaultJobDescription.trim() };
}

export function legacyInterviewProfile(): InterviewProfile {
  return { resume: "", jobDescription: defaultJobDescription.trim() };
}
