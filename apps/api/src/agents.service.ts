import { BadRequestException, Injectable } from '@nestjs/common';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { DeploymentService } from './deployment.service';
import {
  AgentKey,
  ProjectRecord,
  ProjectSnapshot,
  ProjectTarget,
  RunAgentInput,
  RunAgentResult,
} from './orchestrator.types';
import { ProjectStoreService } from './project-store.service';
import { ScaffoldService } from './scaffold.service';

interface ProjectScan {
  files: string[];
  samples: Array<{ path: string; content: string }>;
  technologies: string[];
}

export interface DirectoryBrowserResult {
  current: string;
  parent?: string;
  roots: string[];
  directories: Array<{
    name: string;
    path: string;
  }>;
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly ai: AiOrchestratorService,
    private readonly deployments: DeploymentService,
    private readonly scaffolds: ScaffoldService,
    private readonly store: ProjectStoreService,
  ) {}

  createProject(input: Parameters<ProjectStoreService['createProject']>[0]) {
    return this.store.createProject(input);
  }

  listProjects(): ProjectSnapshot[] {
    return this.store.listProjects();
  }

  getProject(projectId: string): ProjectSnapshot {
    return this.store.getProjectSnapshot(projectId);
  }

  browseDirectories(path?: string): DirectoryBrowserResult {
    const current = resolve(path?.trim() || homedir());
    if (!existsSync(current) || !statSync(current).isDirectory()) {
      throw new BadRequestException('La carpeta seleccionada no existe.');
    }

    const parent = dirname(current);
    const directories = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: join(current, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      current,
      parent: parent === current ? undefined : parent,
      roots: this.getDirectoryRoots(),
      directories,
    };
  }

  addDocuments(
    projectId: string,
    documents: Array<{ name: string; content: string }>,
  ): ProjectSnapshot {
    const project = this.store.getProject(projectId);
    documents.forEach((document) => {
      if (document.content?.trim()) {
        this.store.addDocument(project, document.name, document.content);
      }
    });
    return this.store.getProjectSnapshot(project.id);
  }

  resolveNotification(projectId: string, notificationId: string): ProjectSnapshot {
    const project = this.store.getProject(projectId);
    this.store.resolveNotification(project, notificationId);
    return this.store.getProjectSnapshot(project.id);
  }

  getTestingReportPath(projectId: string): string {
    const project = this.store.getProject(projectId);
    const reportPath = this.store.getLatestTestingReportPath(project);
    if (!reportPath) {
      throw new BadRequestException('Aun no existe un reporte de testing.');
    }
    return reportPath;
  }

  async runAgent(
    projectId: string,
    agentKey: AgentKey,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const project = this.store.getProject(projectId);
    if (input.documents?.length) {
      input.documents.forEach((document) => {
        if (document.content?.trim()) {
          this.store.addDocument(project, document.name, document.content);
        }
      });
    }

    if (agentKey === 'analysis') {
      return this.runAnalysis(project, input);
    }
    if (agentKey === 'developer') {
      return this.runDeveloper(project, input);
    }
    if (agentKey === 'tester') {
      return this.runTester(project, input);
    }
    if (agentKey === 'deployment') {
      return this.runDeployment(project, input);
    }

    throw new BadRequestException('Agente no soportado.');
  }

  private async runAnalysis(
    project: ProjectRecord,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const prompt = input.prompt?.trim() ?? '';
    const runId = this.store.createRun(project, 'analysis', prompt);
    const scan = this.scanProject(project.projectPath);
    const documents = this.store.getDocuments(project);

    if (!scan.files.length && !prompt && !documents.length) {
      this.store.addNotification(
        project,
        'analysis',
        'Agrega reglas de negocio o documentos para completar el levantamiento inicial.',
        'approval',
      );
    }

    const aiResult = await this.ai.generate({
      system:
        'Eres el Agente 1 de levantamiento. Generas un markdown preciso para que un desarrollador entienda negocio, arquitectura, reglas, riesgos y dudas abiertas.',
      prompt: `Proyecto: ${project.name}
Ruta: ${project.projectPath}
Tipo objetivo: ${project.targetType}

Pedido del usuario:
${prompt || 'Sin prompt adicional.'}

Tecnologias detectadas:
${scan.technologies.join(', ') || 'No detectadas'}

Arbol resumido:
${scan.files.join('\n') || 'Sin archivos de codigo detectados.'}

Muestras relevantes:
${this.renderSamples(scan)}

Documentos cargados:
${this.renderDocuments(documents)}

Devuelve SOLO markdown con secciones: Resumen ejecutivo, Logica de negocio, Reglas de negocio, Entidades y flujos, Arquitectura detectada, Prompt base para agentes, Dudas o aprobaciones pendientes.`,
      fallback: () => this.localAnalysis(project, prompt, scan, documents),
    });

    this.store.writeBusinessRules(project, aiResult.text);
    this.store.finishRun(project, runId, 'analysis', 'Finalizado', aiResult.text);
    this.store.remember(project, 'analysis-output', aiResult.text, {
      source: aiResult.source,
    });

    return {
      project: this.store.getProjectSnapshot(project.id),
      output: aiResult.text,
    };
  }

  private async runDeveloper(
    project: ProjectRecord,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const prompt = input.prompt?.trim() ?? '';
    const targetType = this.resolveTargetType(project, prompt, input.targetType);
    const updatedProject =
      targetType !== project.targetType
        ? this.store.updateTarget(project, targetType)
        : project;
    const rules = this.store.readBusinessRules(updatedProject);
    const runId = this.store.createRun(updatedProject, 'developer', prompt);

    if (!prompt) {
      this.store.addNotification(
        updatedProject,
        'developer',
        'El Agente desarrollador necesita una solicitud de cambio para generar el ticket.',
        'approval',
      );
    }

    if (!rules || rules.includes('Pendiente de levantar')) {
      this.store.addNotification(
        updatedProject,
        'developer',
        'Conviene ejecutar primero el Agente 1 para consolidar reglas de negocio.',
        'warning',
      );
    }

    const aiResult = await this.ai.generate({
      system:
        'Eres el Agente 2 desarrollador. Lees reglas de negocio, creas un ticket de ejecucion y defines cambios implementables con bajo riesgo.',
      prompt: `Proyecto: ${updatedProject.name}
Tipo objetivo: ${targetType}

Reglas de negocio vigentes:
${this.truncate(rules, 12000)}

Solicitud del usuario:
${prompt || 'Sin prompt adicional.'}

Devuelve markdown con: Alcance, Ticket de ejecucion, Cambios a realizar, Archivos esperados, Criterios de aceptacion, Riesgos.`,
      fallback: () => this.localDeveloperPlan(updatedProject, targetType, prompt, rules),
    });

    const ticket = this.store.createTicket(
      updatedProject,
      `Ejecucion ${new Date().toISOString().slice(0, 10)} - ${updatedProject.name}`,
      prompt || 'Solicitud pendiente de detalle.',
      aiResult.text,
    );
    const scaffold = this.scaffolds.applyDevelopmentRequest(
      updatedProject,
      targetType,
      prompt,
      rules,
      ticket.id,
    );
    const output = `${aiResult.text}

## Resultado de ejecucion

${scaffold.summary}

## Archivos generados o verificados

${scaffold.files.map((file) => `- ${file}`).join('\n') || '- Sin archivos generados.'}

## Comandos sugeridos

${scaffold.commands.map((command) => `- ${command}`).join('\n') || '- No aplica.'}
`;

    this.store.finishRun(updatedProject, runId, 'developer', 'Finalizado', output, {
      ticketId: ticket.id,
    });
    this.store.remember(updatedProject, 'developer-output', output, {
      ticketId: ticket.id,
      source: aiResult.source,
    });

    return {
      project: this.store.getProjectSnapshot(updatedProject.id),
      output,
      ticket,
    };
  }

  private async runTester(
    project: ProjectRecord,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const prompt = input.prompt?.trim() ?? '';
    const runId = this.store.createRun(project, 'tester', prompt);
    const scan = this.scanProject(project.projectPath);
    const rules = this.store.readBusinessRules(project);
    const snapshot = this.store.getProjectSnapshot(project.id);

    const aiResult = await this.ai.generate({
      system:
        'Eres el Agente 3 tester. Auditas seguridad, escalabilidad, arquitectura, testing y operacion. No ejecutas cambios; devuelves instrucciones priorizadas.',
      prompt: `Proyecto: ${project.name}
Tipo objetivo: ${project.targetType}

Reglas de negocio:
${this.truncate(rules, 12000)}

Ultimo ticket:
${snapshot.latestTicket?.summary ?? 'Sin ticket de desarrollo.'}

Arbol resumido:
${scan.files.join('\n') || 'Sin archivos detectados.'}

Pedido adicional:
${prompt || 'Sin prompt adicional.'}

Devuelve un reporte markdown con: Resumen, Hallazgos criticos, Seguridad, Escalabilidad, Arquitectura sugerida, Pruebas recomendadas, Checklist para Agente 2.`,
      fallback: () => this.localTestingReport(project, prompt, scan, rules),
    });

    const reportPath = this.store.saveReport(project, aiResult.text);
    this.store.finishRun(project, runId, 'tester', 'Finalizado', aiResult.text, {
      reportPath,
    });

    return {
      project: this.store.getProjectSnapshot(project.id),
      output: aiResult.text,
      reportPath,
    };
  }

  private async runDeployment(
    project: ProjectRecord,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const prompt = input.prompt?.trim() ?? '';
    const targetType = this.resolveTargetType(project, prompt, input.targetType);
    const updatedProject =
      targetType !== project.targetType
        ? this.store.updateTarget(project, targetType)
        : project;
    const runId = this.store.createRun(updatedProject, 'deployment', prompt);
    const deployment = await this.deployments.deploy(updatedProject, targetType);
    const savedDeployment = this.store.saveDeployment(updatedProject, deployment);
    const output = `# Despliegue

Estado: ${deployment.status}

URL: ${deployment.url}

Usuario: ${deployment.username}

Contrasena: ${deployment.password}

Comando: ${deployment.command || 'Pendiente de definir'}

## Logs

\`\`\`text
${deployment.logs || 'Sin logs.'}
\`\`\`
`;

    if (!deployment.started) {
      this.store.addNotification(
        updatedProject,
        'deployment',
        'El despliegue necesita una aclaracion o fallo al ejecutar comandos. Revisa logs y confirma el comando correcto.',
        'approval',
      );
    }

    this.store.finishRun(
      updatedProject,
      runId,
      'deployment',
      deployment.started ? 'Levantado' : 'Sugiriendo',
      output,
    );

    return {
      project: this.store.getProjectSnapshot(updatedProject.id),
      output,
      deployment: savedDeployment,
    };
  }

  private scanProject(projectPath: string): ProjectScan {
    const ignored = new Set([
      '.git',
      '.agents-ai',
      '.bundle',
      '.gradle',
      '.idea',
      '.expo',
      '.turbo',
      'android',
      'ios',
      'node_modules',
      'dist',
      'build',
      'coverage',
      'Pods',
      'DerivedData',
      'target',
      '.next',
      '.nuxt',
      '.vite',
    ]);
    const files: string[] = [];
    const samples: Array<{ path: string; content: string }> = [];
    const technologies = new Set<string>();
    let visitedDirectories = 0;
    const maxFiles = 120;
    const maxDirectories = 90;
    const maxEntriesPerDirectory = 140;

    const visit = (current: string, depth: number) => {
      if (
        depth > 4 ||
        files.length >= maxFiles ||
        visitedDirectories >= maxDirectories ||
        !existsSync(current)
      ) {
        return;
      }
      visitedDirectories += 1;

      for (const entry of readdirSync(current).slice(0, maxEntriesPerDirectory)) {
        if (files.length >= maxFiles || visitedDirectories >= maxDirectories) {
          return;
        }
        if (ignored.has(entry)) {
          continue;
        }
        const absolute = join(current, entry);
        let stats;
        try {
          stats = statSync(absolute);
        } catch {
          continue;
        }
        const rel = relative(projectPath, absolute).replace(/\\/g, '/');
        if (stats.isDirectory()) {
          visit(absolute, depth + 1);
          continue;
        }
        if (this.shouldIgnoreFile(rel)) {
          continue;
        }
        files.push(rel);
        this.detectTechnology(rel, technologies);
        if (this.shouldSample(rel, stats.size) && samples.length < 18) {
          samples.push({
            path: rel,
            content: this.truncate(readFileSync(absolute, 'utf8'), 4500),
          });
        }
      }
    };

    visit(projectPath, 0);
    return {
      files: files.slice(0, maxFiles),
      samples,
      technologies: Array.from(technologies),
    };
  }

  private getDirectoryRoots(): string[] {
    if (process.platform !== 'win32') {
      return ['/'];
    }

    const roots: string[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (existsSync(root)) {
        roots.push(root);
      }
    }
    return roots;
  }

  private resolveTargetType(
    project: ProjectRecord,
    prompt: string,
    requested?: ProjectTarget,
  ): ProjectTarget {
    if (requested && requested !== 'unknown') {
      return requested;
    }
    if (project.targetType !== 'unknown') {
      return project.targetType;
    }

    const normalizedPrompt = prompt
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (/\b(java|jar|ejecutable|spring|maven)\b/.test(normalizedPrompt)) {
      return 'executable';
    }
    if (/\b(web|vue|nestjs|nest|frontend|api|dashboard)\b/.test(normalizedPrompt)) {
      return 'web';
    }
    if (existsSync(join(project.projectPath, 'pom.xml'))) {
      return 'executable';
    }
    return 'web';
  }

  private detectTechnology(path: string, technologies: Set<string>): void {
    if (path.endsWith('package.json')) {
      technologies.add('Node.js');
    }
    if (path.endsWith('pom.xml')) {
      technologies.add('Java/Maven');
    }
    if (path.endsWith('.vue')) {
      technologies.add('Vue');
    }
    if (path.endsWith('.ts')) {
      technologies.add('TypeScript');
    }
    if (path.includes('nestjs') || path.endsWith('app.module.ts')) {
      technologies.add('NestJS');
    }
    if (path.endsWith('schema.prisma')) {
      technologies.add('Prisma');
    }
  }

  private shouldSample(path: string, size: number): boolean {
    if (size > 120000) {
      return false;
    }
    return (
      path.endsWith('package.json') ||
      path.endsWith('pom.xml') ||
      path.endsWith('README.md') ||
      path.endsWith('schema.prisma') ||
      path.endsWith('main.ts') ||
      path.endsWith('App.vue') ||
      path.endsWith('app.module.ts')
    );
  }

  private shouldIgnoreFile(path: string): boolean {
    const fileName = path.split('/').at(-1)?.toLowerCase() ?? '';
    if (
      fileName === '.env' ||
      fileName.startsWith('.env.') ||
      fileName.endsWith('.keystore') ||
      fileName === 'google-services.json' ||
      fileName === 'google-services-info.plist'
    ) {
      return true;
    }
    return path.includes('/.gradle/') || path.includes('/.idea/');
  }

  private renderSamples(scan: ProjectScan): string {
    if (!scan.samples.length) {
      return 'Sin muestras.';
    }
    return scan.samples
      .map(
        (sample) => `### ${sample.path}

\`\`\`text
${sample.content}
\`\`\``,
      )
      .join('\n\n');
  }

  private renderDocuments(
    documents: Array<{ name: string; content: string; createdAt: string }>,
  ): string {
    if (!documents.length) {
      return 'Sin documentos cargados.';
    }
    return documents
      .slice(0, 12)
      .map(
        (document) => `### ${document.name}

${this.truncate(document.content, 6000)}`,
      )
      .join('\n\n');
  }

  private localAnalysis(
    project: ProjectRecord,
    prompt: string,
    scan: ProjectScan,
    documents: Array<{ name: string; content: string }>,
  ): string {
    return `# Levantamiento de informacion - ${project.name}

## Resumen ejecutivo

${scan.files.length ? 'Se detecto una base de codigo existente.' : 'No se detecto codigo de negocio fuera de la carpeta de agentes.'}

Tecnologias detectadas: ${scan.technologies.join(', ') || 'pendiente de confirmar'}.

## Logica de negocio

${prompt || documents.map((item) => item.content).join('\n\n') || 'Pendiente: agrega reglas de negocio, procesos, roles y restricciones.'}

## Reglas de negocio

- Toda solicitud del Agente 2 debe leer este archivo antes de proponer cambios.
- Los cambios deben registrar ticket de ejecucion.
- Las dudas se convierten en notificaciones de aprobacion.

## Entidades y flujos

- Entidades detectadas: pendiente de confirmar en codigo o documentos.
- Flujo principal: usuario solicita cambio, Agente 2 genera ticket, Agente 3 audita, Agente 4 despliega.

## Arquitectura detectada

Archivos principales:

${scan.files.slice(0, 60).map((file) => `- ${file}`).join('\n') || '- Sin archivos detectados.'}

## Prompt base para agentes

Usa estas reglas como memoria del proyecto. Antes de modificar o sugerir, valida alcance, dependencias, criterios de aceptacion, seguridad, escalabilidad y despliegue.

## Dudas o aprobaciones pendientes

- Confirmar roles, permisos, datos sensibles y reglas de validacion.
- Confirmar si el objetivo final es web, ejecutable Java o ambos.
`;
  }

  private localDeveloperPlan(
    project: ProjectRecord,
    targetType: ProjectTarget,
    prompt: string,
    rules: string,
  ): string {
    return `# Plan del Agente desarrollador

## Alcance

Proyecto: ${project.name}

Tipo objetivo: ${targetType}

Solicitud: ${prompt || 'Pendiente de detalle por parte del usuario.'}

## Ticket de ejecucion

Se creara un ticket en la memoria SQLite del proyecto y un archivo markdown en .agents-ai/tickets.

## Cambios a realizar

- Leer reglas de negocio antes de tocar codigo.
- Generar estructura base si el proyecto esta vacio.
- Mantener archivos existentes sin sobrescritura automatica.

## Archivos esperados

- business-rules.md
- ticket de ejecucion
- scaffold ${targetType === 'executable' ? 'Java/Spring Boot' : 'NestJS/Vue'} cuando aplique

## Criterios de aceptacion

- El proyecto conserva memoria por SQLite propio.
- El cambio queda trazado en ticket.
- El siguiente paso puede ser auditado por el Agente 3.

## Riesgos

${rules ? '- Reglas cargadas parcialmente; revisar dudas abiertas.' : '- Falta levantar reglas de negocio con el Agente 1.'}
`;
  }

  private localTestingReport(
    project: ProjectRecord,
    prompt: string,
    scan: ProjectScan,
    rules: string,
  ): string {
    return `# Reporte de testing - ${project.name}

## Resumen

Auditoria local generada sobre ${scan.files.length} archivos detectados.

## Hallazgos criticos

- Validar autenticacion real antes de exponer el proyecto.
- Evitar guardar secretos en repositorio; usar variables de entorno.
- Agregar pruebas automatizadas sobre reglas de negocio principales.

## Seguridad

- Rotar la contrasena default despues del primer acceso.
- Agregar hashing de contrasenas y control de sesiones si existe login.
- Revisar CORS, limites de payload y validacion de DTOs.

## Escalabilidad

- Separar configuracion por ambiente.
- Agregar logs estructurados y health checks.
- Definir estrategia de base de datos antes de crecer en usuarios.

## Arquitectura sugerida

${project.targetType === 'executable' ? '- Para Java, empaquetar jar reproducible y externalizar configuracion.' : '- Para web, mantener API NestJS separada de UI Vue y compartir contratos por DTOs.'}

## Pruebas recomendadas

- Unitarias para reglas de negocio.
- Integracion para endpoints criticos.
- E2E minimo de login y flujo principal.

## Checklist para Agente 2

- ${prompt || 'Convertir estos hallazgos en tareas priorizadas.'}
- Completar reglas pendientes: ${rules ? 'revisar dudas abiertas del markdown.' : 'ejecutar Agente 1.'}
- Agregar pruebas antes de cerrar ticket.
`;
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max)}\n... [contenido truncado]`;
  }
}
