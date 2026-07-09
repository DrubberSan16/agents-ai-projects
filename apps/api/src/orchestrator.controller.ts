import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentsService } from './agents.service';
import { AGENT_KEYS, AgentKey } from './orchestrator.types';
import type { CreateProjectInput, RunAgentInput } from './orchestrator.types';

@Controller('api')
export class OrchestratorController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get('projects')
  listProjects() {
    return this.agentsService.listProjects();
  }

  @Post('projects')
  createProject(@Body() body: CreateProjectInput) {
    return this.agentsService.createProject({
      name: body.name,
      mode: body.mode ?? 'new',
      path: body.path,
      targetType: body.targetType ?? 'unknown',
      businessRules: body.businessRules,
    });
  }

  @Get('directories')
  browseDirectories(@Query('path') path?: string) {
    return this.agentsService.browseDirectories(path);
  }

  @Get('projects/:projectId')
  getProject(@Param('projectId') projectId: string) {
    return this.agentsService.getProject(projectId);
  }

  @Post('projects/:projectId/documents')
  addDocuments(
    @Param('projectId') projectId: string,
    @Body() body: { documents?: Array<{ name: string; content: string }> },
  ) {
    return this.agentsService.addDocuments(projectId, body.documents ?? []);
  }

  @Post('projects/:projectId/agents/:agentKey/run')
  runAgent(
    @Param('projectId') projectId: string,
    @Param('agentKey') agentKey: string,
    @Body() body: RunAgentInput,
  ) {
    if (!AGENT_KEYS.includes(agentKey as AgentKey)) {
      throw new BadRequestException('Agente no soportado.');
    }
    return this.agentsService.runAgent(projectId, agentKey as AgentKey, body ?? {});
  }

  @Post('projects/:projectId/notifications/:notificationId/resolve')
  resolveNotification(
    @Param('projectId') projectId: string,
    @Param('notificationId') notificationId: string,
  ) {
    return this.agentsService.resolveNotification(projectId, notificationId);
  }

  @Get('projects/:projectId/agents/:agentKey/report/download')
  downloadAgentReport(
    @Param('projectId') projectId: string,
    @Param('agentKey') agentKey: string,
    @Res() response: Response,
  ) {
    if (!AGENT_KEYS.includes(agentKey as AgentKey)) {
      throw new BadRequestException('Agente no soportado.');
    }
    const report = this.agentsService.getAgentReport(projectId, agentKey as AgentKey);
    return response.download(report.path, report.fileName);
  }

  @Get('projects/:projectId/testing-report/download')
  downloadTestingReport(
    @Param('projectId') projectId: string,
    @Res() response: Response,
  ) {
    const reportPath = this.agentsService.getTestingReportPath(projectId);
    return response.download(reportPath, 'testing-report.md');
  }
}
