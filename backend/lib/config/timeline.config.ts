/*
    定义面试过程的时间线
    0-3分钟 自我介绍
    3-10分钟 项目讨论
    10-25分钟 技术讨论
    25-30分钟 非技术问题讨论
    30-32分钟 反问
    32分钟以上 结束
*/

import { INTERVIEW_DURATION_MINUTES } from "../../../shared/interview";

export interface TimelineStep {
  startTime: number;
  endTime: number;
  focus: string; // 聚焦的问题，例如项目、技术、代码、算法、非技术问题
  prompt: string; // 提示语
}

interface TimelineConfig {
  steps: TimelineStep[];
}

export const timelineConfig: TimelineConfig = {
  steps: [
    {
      startTime: 0,
      endTime: 3,
      focus: "自我介绍",
      prompt: `当前在自我介绍阶段。已提供的简历是候选人背景，你先阅读简历并引导候选人简短介绍，不再要求粘贴简历，也不要求逐项重复已有资料。简历未覆盖且与岗位相关的信息可以逐步确认：
            1. 个人信息
            2. 教育背景
            3. 工作经历
            4. 项目经历
            5. 擅长的技术
            6. 自我评价

            你首先根据<memory>的信息，判断候选人是否完成了介绍，如果没有完成，你询问并收集候选人缺失的信息，以便于后续面试。
            `,
    },
    {
      startTime: 3,
      endTime: 10,
      focus: "项目讨论",
      prompt: `当前在项目讨论阶段，你要求候选人讨论他在项目中的表现。
            你首先根据<memory>的信息，回顾 interviewSummary，针对你感兴趣的项目经历或技术细节，深入询问候选人，务必问出技术深度，以便于判断候选人整体的技术能力。
            `,
    },
    {
      startTime: 10,
      endTime: 25,
      focus: "技术讨论",
      prompt: `当前在技术讨论阶段，你要求候选人讨论他在技术方面的表现。
            如果你之前在和候选人讨论他过往项目，你可以收尾，然后开始讨论该岗位的专业技能和基础知识。
            首先根据候选人应聘的岗位描述，判断对专业知识和技能的总体要求，并结合简历和<memory>的信息，深入询问相关知识与实践，以便判断候选人的岗位能力。
            根据岗位选择问题顺序，先基础知识，再工具或框架，最后实践、设计与优化；不要默认所有岗位都考查前端技术。
            你通过<memory>中的askedQuestions回溯之前的问题，以把控整体节奏。
            `,
    },
    {
      startTime: 25,
      endTime: 30,
      focus: "非技术问题讨论",
      prompt: `当前在非技术问题讨论阶段，当前在非技术问题讨论阶段，你要求候选人讨论他在软素质方面的表现。
            如果你之前在和候选人讨论专业技能和基础知识，你可以收尾，然后开始讨论非技术问题。
            首先根据候选人应聘的岗位描述，判断对软素质的总体要求，并结合<memory>的信息，针对你感兴趣的软素质点，深入询问候选人，务必了解候选人的想法，以便于判断候选人的软素质能力。
            整体节奏上你按照价值观、团队沟通协作、项目管理、时间管理、学习能力、沟通表达能力、解决问题能力、自我认知等顺序，逐个询问候选人。
            你通过<memory>中的askedQuestions回溯之前的问题，以把控整体节奏。
            `,
    },
    {
      startTime: 30,
      endTime: INTERVIEW_DURATION_MINUTES,
      focus: "反问",
      prompt: `当前在反问阶段，你要求候选人反问面试官，补充判断候选人对岗位是否有兴趣。
            候选人提问后，你进行回答，如果候选人说没有问题了，你可以结束面试。
            `,
    },
    {
      startTime: INTERVIEW_DURATION_MINUTES,
      endTime: Infinity,
      focus: "结束",
      prompt: `在当前结束阶段，你礼貌地与候选人沟通，结束面试`,
    },
  ],
};
