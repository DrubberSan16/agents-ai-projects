import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentsService } from './agents.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DeploymentService } from './deployment.service';
import { OrchestratorController } from './orchestrator.controller';
import { ProjectStoreService } from './project-store.service';
import { ScaffoldService } from './scaffold.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env', 'apps/api/.env'],
      isGlobal: true,
    }),
  ],
  controllers: [AppController, OrchestratorController],
  providers: [
    AgentsService,
    AiOrchestratorService,
    AppService,
    DeploymentService,
    ProjectStoreService,
    ScaffoldService,
  ],
})
export class AppModule {}
