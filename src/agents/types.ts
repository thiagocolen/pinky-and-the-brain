import { BaseMessage } from "@langchain/core/messages";

export interface AgentWorkspaceState {
  messages: BaseMessage[];
  nextAgent: "the-brain" | "aws-tutor" | "cellular-automata" | "english-certification-instructor" | "job-technical-interviewer" | "end";
  routingStack?: string[];
  brainIntroduction?: string;
  
  instructorState?: {
    userQuestion: string;
    explanation?: string;
    suggestedTopics?: string[];
  };

  // New state fields specific to The Brain
  brainState?: {
    selectedArea?: string;
    interactionMode?: "interactive" | "article";
    activeQuiz?: {
      questions: Array<{
        question: string;
        options: string[];
        answer: string;
        explanation: string;
      }>;
      currentQuestionIndex: number;
      score: number;
    };
  };
}
