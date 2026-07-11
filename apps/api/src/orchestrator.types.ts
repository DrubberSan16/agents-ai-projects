export const AGENT_KEYS = [
  'analysis',
  'developer',
  'tester',
  'deployment',
] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

export type AgentStatus =
  | 'Inicializado'
  | 'Procesando'
  | 'Sugiriendo'
  | 'Finalizado'
  | 'Levantado';

export type ProjectMode = 'new' | 'existing';
export type ProjectTarget = 'web' | 'executable' | 'unknown';

export interface CreateProjectInput {
  name: string;
  mode: ProjectMode;
  path?: string;
  targetType?: ProjectTarget;
  businessRules?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  mode: ProjectMode;
  targetType: ProjectTarget;
  projectPath: string;
  sqlitePath: string;
  rulesPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  key: AgentKey;
  status: AgentStatus;
  summary: string;
  lastRunId?: string;
  updatedAt: string;
}

export interface ProjectNotification {
  id: string;
  agentKey: AgentKey;
  level: 'info' | 'warning' | 'approval';
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface DevelopmentTicket {
  id: string;
  title: string;
  status: string;
  prompt: string;
  summary: string;
  filePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentInfo {
  id: string;
  port: number;
  url: string;
  username: string;
  password: string;
  status: string;
  command: string;
  logs: string;
  createdAt: string;
}

export interface ProjectSnapshot extends ProjectRecord {
  agents: AgentState[];
  notifications: ProjectNotification[];
  latestTicket?: DevelopmentTicket;
  latestDeployment?: DeploymentInfo;
  hasTestingReport: boolean;
  documentCount: number;
}

export interface RunAgentInput {
  prompt?: string;
  documents?: Array<{
    name: string;
    content: string;
    mimeType?: string;
    kind?: 'text' | 'image' | 'file';
  }>;
  deepAnalysis?: boolean;
  targetType?: ProjectTarget;
}

export interface RunAgentResult {
  project: ProjectSnapshot;
  output: string;
  reportPath?: string;
  ticket?: DevelopmentTicket;
  deployment?: DeploymentInfo;
}
