export interface HealthIssue {
  severity: "CRITICAL" | "WARNING";
  title: string;
  resourceType: string;
  resourceName: string;
  namespace?: string;
  status: string;
  description: string;
  rootCause: string;
  suggestedFixes: SuggestedFix[];
  riskLevel: "Low" | "Medium" | "High";
  notes?: string;
}

export interface SuggestedFix {
  type: "kubectl" | "yaml" | "aws-cli";
  description: string;
  command?: string;
  manifest?: string;
}

export interface HealthReport {
  cluster: string;
  timestamp: Date;
  issues: HealthIssue[];
  summary: {
    totalIssues: number;
    criticalCount: number;
    warningCount: number;
    healthStatus: "healthy" | "degraded" | "critical";
  };
}

export interface AgentMessage {
  type: "text" | "tool_use" | "tool_result" | "system" | "result";
  content?: string;
  result?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}
