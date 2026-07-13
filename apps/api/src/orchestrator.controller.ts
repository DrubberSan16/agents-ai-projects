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
import { readFileSync } from 'node:fs';
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
    @Body()
    body: {
      documents?: Array<{
        name: string;
        content: string;
        mimeType?: string;
        kind?: 'text' | 'image' | 'file';
      }>;
    },
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

  @Post('projects/:projectId/notifications/:notificationId/approve')
  approveNotification(
    @Param('projectId') projectId: string,
    @Param('notificationId') notificationId: string,
  ) {
    return this.agentsService.approveNotification(projectId, notificationId);
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
    return this.sendPdf(response, report.path, report.fileName);
  }

  @Get('projects/:projectId/testing-report/download')
  downloadTestingReport(
    @Param('projectId') projectId: string,
    @Res() response: Response,
  ) {
    const reportPath = this.agentsService.getTestingReportPath(projectId);
    return this.sendPdf(response, reportPath, 'testing-report.pdf');
  }

  private sendPdf(response: Response, filePath: string, fileName: string) {
    const safeName = fileName.replace(/["\r\n]/g, '');
    const buffer = readFileSync(filePath);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    );
    response.setHeader('Content-Length', buffer.length);
    return response.send(buffer);
  }
}
