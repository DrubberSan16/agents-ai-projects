import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  deep: boolean;
  visitedDirectories: number;
  truncated: boolean;
}

interface ScanOptions {
  deep?: boolean;
}

interface ProjectDocument {
  name: string;
  content: string;
  createdAt?: string;
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
    private readonly configService: ConfigService,
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
      const content = this.normalizeDocumentContent(document.name, document.content);
      if (content) {
        this.store.addDocument(project, document.name, content);
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

  getAgentReport(
    projectId: string,
    agentKey: AgentKey,
  ): { path: string; fileName: string } {
    const project = this.store.getProject(projectId);
    if (agentKey === 'tester') {
      const testingReport = this.store.getLatestTestingReportPath(project);
      if (testingReport) {
        return {
          path: testingReport,
          fileName: `${project.slug}-tester-report.md`,
        };
      }
    }

    const latestRun = this.store.getLatestAgentRun(project, agentKey);
    if (!latestRun?.output?.trim()) {
      throw new BadRequestException('Aun no existe una salida generada para este agente.');
    }

    const reportPath =
      latestRun.reportPath && existsSync(latestRun.reportPath)
        ? latestRun.reportPath
        : this.store.saveAgentOutputReport(project, agentKey, latestRun.output);

    return {
      path: reportPath,
      fileName: `${project.slug}-${agentKey}-report.md`,
    };
  }

  async runAgent(
    projectId: string,
    agentKey: AgentKey,
    input: RunAgentInput,
  ): Promise<RunAgentResult> {
    const project = this.store.getProject(projectId);
    if (input.documents?.length) {
      input.documents.forEach((document) => {
        const content = this.normalizeDocumentContent(document.name, document.content);
        if (content) {
          this.store.addDocument(project, document.name, content);
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
    const deepAnalysis = Boolean(input.deepAnalysis);
    const runId = this.store.createRun(
      project,
      'analysis',
      deepAnalysis ? `[Analisis profundo]\n${prompt}`.trim() : prompt,
    );
    const scan = this.scanProject(project.projectPath, { deep: deepAnalysis });
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
        'Eres el Agente 1 de levantamiento y arquitectura. Generas un markdown tecnico, accionable y suficientemente descriptivo para que un desarrollador implemente el sistema sin volver a leer todo el proyecto.',
      prompt: `Proyecto: ${project.name}
Ruta: ${project.projectPath}
Tipo objetivo: ${project.targetType}
Modo de analisis: ${deepAnalysis ? 'profundo' : 'rapido'}
Cobertura del escaneo: ${scan.files.length} archivos listados, ${scan.samples.length} muestras relevantes, ${scan.visitedDirectories} carpetas visitadas.${scan.truncated ? ' El escaneo alcanzo los limites de seguridad configurados.' : ''}

Pedido del usuario:
${prompt || 'Sin prompt adicional.'}

Tecnologias detectadas:
${scan.technologies.join(', ') || 'No detectadas'}

Arbol resumido:
${this.truncate(scan.files.join('\n') || 'Sin archivos de codigo detectados.', deepAnalysis ? 65000 : 25000)}

Muestras relevantes:
${this.truncate(this.renderSamples(scan), deepAnalysis ? 120000 : 70000)}

Documentos cargados:
${this.renderDocuments(documents)}

Devuelve SOLO markdown con estas secciones obligatorias:
1. Resumen ejecutivo
2. Logica de negocio
3. Reglas de negocio
4. Entidades y flujos
5. Arquitectura tecnica ${project.mode === 'new' ? 'recomendada' : 'detectada y recomendada'}
6. Stack de desarrollo sugerido
7. Estructura de modulos y archivos esperados
8. Diagramas Mermaid: arquitectura de componentes, flujo principal y modelo de datos
9. Criterios tecnicos para el Agente 2
10. Dudas o aprobaciones pendientes.

Para proyectos nuevos, propone una arquitectura completa para ${project.targetType === 'executable' ? 'Java ejecutable empaquetable en JAR' : 'NestJS + Vue'} con capas, modulos, DTOs, servicios, persistencia, autenticacion, validaciones, testing y despliegue local.`,
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
    const rules = this.store.readBusinessRules(project);
    const requestedChange = prompt || this.inferDeveloperRequest(project, rules);
    const targetType = this.resolveTargetType(project, requestedChange, input.targetType);
    const updatedProject =
      targetType !== project.targetType
        ? this.store.updateTarget(project, targetType)
        : project;
    const runId = this.store.createRun(updatedProject, 'developer', requestedChange);
    this.store.resolveOpenNotifications(
      updatedProject,
      'developer',
      'El Agente desarrollador necesita una solicitud de cambio',
    );

    if (!prompt) {
      this.store.addNotification(
        updatedProject,
        'developer',
        `No se ingreso una solicitud manual. El Agente 2 continuara con este cambio sugerido: ${requestedChange}`,
        'info',
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

    try {
      const aiResult = await this.ai.generate({
        system:
          'Eres el Agente 2 desarrollador tipo Codex. Lees reglas de negocio, interpretas la arquitectura definida y produces una implementacion concreta: archivos, modulos, endpoints, UI, validaciones, pruebas y comandos. No te limites a un plan generico.',
        prompt: `Proyecto: ${updatedProject.name}
Tipo objetivo: ${targetType}

Reglas de negocio vigentes:
${this.truncate(rules, 12000)}

Solicitud del usuario:
${requestedChange}

Devuelve markdown con:
1. Alcance implementado
2. Ticket de ejecucion
3. Arquitectura aplicada
4. Archivos creados o modificados
5. Logica de negocio implementada por modulo
6. CRUD completo por entidad detectada
7. Seguridad, usuarios, roles, validaciones y politicas iniciales
8. Mantenedores o catalogos operativos
9. Reporteria, dashboards, metricas y exportaciones
10. Endpoints o pantallas disponibles
11. Criterios de aceptacion
12. Pruebas sugeridas
13. Riesgos o pendientes.

No generes modulos genericos vacios. Extrae entidades, reglas, flujos, validaciones y restricciones del analisis previo y materializalos en archivos concretos. Si el proyecto es nuevo, genera una aplicacion funcional completa segun las reglas, no solo una estructura base. Si falta detalle, implementa una version inicial coherente y marca los pendientes como dudas.`,
        fallback: () => this.localDeveloperPlan(updatedProject, targetType, requestedChange, rules),
        timeoutMs: this.getDeveloperTimeoutMs(),
      });

      const ticket = this.store.createTicket(
        updatedProject,
        `Ejecucion ${new Date().toISOString().slice(0, 10)} - ${updatedProject.name}`,
        requestedChange,
        aiResult.text,
      );
      const scaffold = this.scaffolds.applyDevelopmentRequest(
        updatedProject,
        targetType,
        requestedChange,
        rules,
        ticket.id,
      );
      const output = `${aiResult.text}

## Resultado de ejecucion

${scaffold.summary}

## Logica de negocio materializada

- Se usaron las reglas consolidadas en business-rules.md como fuente de contexto.
- Se genero o actualizo una implementacion inicial para autenticacion, CRUD del dominio, mantenedores, reporteria y seguridad.
- Los archivos generados dejan endpoints, pantallas, validaciones de reglas y documentacion tecnica listos para iterar con nuevas solicitudes.

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = `# Desarrollo

Estado: requiere reintento

El Agente 2 no pudo completar la generacion con OpenAI.

## Error

\`\`\`text
${message}
\`\`\`

## Que hacer

- Verifica conectividad hacia api.openai.com.
- Confirma que OPENAI_API_KEY y OPENAI_MODEL esten correctos en apps/api/.env.
- Reinicia el API del orquestador despues de cambiar variables de entorno.
- Ejecuta nuevamente el Agente 2 con el mismo prompt.
`;
      this.store.addNotification(
        updatedProject,
        'developer',
        `El Agente 2 fallo antes de generar archivos: ${message}`,
        'warning',
      );
      this.store.finishRun(updatedProject, runId, 'developer', 'Sugiriendo', output);

      return {
        project: this.store.getProjectSnapshot(updatedProject.id),
        output,
      };
    }
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
    const developerPrompt = this.buildTestingDeveloperPrompt(
      project,
      prompt,
      scan,
      rules,
      snapshot.latestTicket?.summary ?? '',
    );

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

Prompt sugerido para Agente 2:
${developerPrompt}

Devuelve un reporte markdown con: Resumen, Hallazgos criticos, Seguridad, Escalabilidad, Arquitectura sugerida, Pruebas recomendadas, Checklist para Agente 2, Prompt completo para Agente 2.

En la seccion "Prompt completo para Agente 2", incluye un bloque \`\`\`text con el prompt completo y listo para copiar. Debe contener objetivo, contexto, hallazgos, archivos/modulos a tocar, criterios de aceptacion y pruebas esperadas.`,
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
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = `# Despliegue

Estado: fallo-despliegue

URL: pendiente

Usuario: pendiente

Contrasena: pendiente

Comando: pendiente de confirmar

## Logs

\`\`\`text
${message}
\`\`\`
`;
      this.store.addNotification(
        updatedProject,
        'deployment',
        `El despliegue fallo antes de completar la ejecucion: ${message}`,
        'approval',
      );
      this.store.finishRun(updatedProject, runId, 'deployment', 'Sugiriendo', output);

      return {
        project: this.store.getProjectSnapshot(updatedProject.id),
        output,
      };
    }
  }

  private scanProject(projectPath: string, options: ScanOptions = {}): ProjectScan {
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
    let truncated = false;
    const deep = Boolean(options.deep);
    const limits = deep
      ? {
          maxDepth: 12,
          maxFiles: 1500,
          maxDirectories: 900,
          maxEntriesPerDirectory: 500,
          sampleLimit: 60,
          sampleSize: 8000,
        }
      : {
          maxDepth: 4,
          maxFiles: 120,
          maxDirectories: 90,
          maxEntriesPerDirectory: 140,
          sampleLimit: 18,
          sampleSize: 4500,
        };

    const visit = (current: string, depth: number) => {
      if (
        depth > limits.maxDepth ||
        files.length >= limits.maxFiles ||
        visitedDirectories >= limits.maxDirectories ||
        !existsSync(current)
      ) {
        if (depth > limits.maxDepth || files.length >= limits.maxFiles) {
          truncated = true;
        }
        return;
      }
      visitedDirectories += 1;

      let rawEntries;
      try {
        rawEntries = readdirSync(current);
      } catch {
        truncated = true;
        return;
      }
      const entries = rawEntries.slice(0, limits.maxEntriesPerDirectory);
      if (rawEntries.length > limits.maxEntriesPerDirectory) {
        truncated = true;
      }

      for (const entry of entries) {
        if (
          files.length >= limits.maxFiles ||
          visitedDirectories >= limits.maxDirectories
        ) {
          truncated = true;
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
        if (this.shouldSample(rel, stats.size, deep) && samples.length < limits.sampleLimit) {
          samples.push({
            path: rel,
            content: this.truncate(readFileSync(absolute, 'utf8'), limits.sampleSize),
          });
        }
      }
    };

    visit(projectPath, 0);
    return {
      files: files.slice(0, limits.maxFiles),
      samples,
      technologies: Array.from(technologies),
      deep,
      visitedDirectories,
      truncated,
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

  private getDeveloperTimeoutMs(): number {
    return Number(
      this.configService.get<string>('OPENAI_DEVELOPER_TIMEOUT_MS') ?? 1800000,
    );
  }

  private inferDeveloperRequest(project: ProjectRecord, rules: string): string {
    const entities = this.extractSectionLines(rules, [
      'Entidades y flujos',
      'Estructura de modulos y archivos esperados',
      'Modulos solicitados implementados',
    ]).slice(0, 8);
    const businessRules = this.extractSectionLines(rules, [
      'Reglas de negocio',
      'Criterios tecnicos para el Agente 2',
    ]).slice(0, 8);
    const architecture = this.extractSectionLines(rules, [
      'Arquitectura tecnica recomendada',
      'Arquitectura tecnica detectada y recomendada',
      'Stack de desarrollo sugerido',
    ]).slice(0, 6);

    const target =
      project.targetType === 'executable'
        ? 'Java ejecutable empaquetable como JAR'
        : 'NestJS + Vue';

    return [
      `Implementar la primera version funcional del sistema "${project.name}" usando ${target}.`,
      'Debe materializar los modulos propios detectados en el analisis previo, no solo modulos transversales.',
      'Incluye CRUD completo por modulo/entidad, validaciones de reglas de negocio, seguridad inicial, usuarios/roles, mantenedores, reportería, dashboards, exportaciones y documentacion tecnica.',
      entities.length ? `Modulos o entidades detectadas: ${entities.join('; ')}.` : '',
      businessRules.length ? `Reglas principales a aplicar: ${businessRules.join('; ')}.` : '',
      architecture.length ? `Arquitectura a respetar: ${architecture.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private extractSectionLines(markdown: string, sectionNames: string[]): string[] {
    const normalizedNames = sectionNames.map((name) => this.normalizeText(name));
    const lines = markdown.split(/\r?\n/);
    const results: string[] = [];
    let capture = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        const headingName = this.normalizeText(heading[1]);
        capture = normalizedNames.some((name) => headingName.includes(name));
        continue;
      }
      if (!capture) {
        continue;
      }
      const cleaned = line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (
        cleaned &&
        !cleaned.startsWith('```') &&
        !/^(flowchart|sequenceDiagram|erDiagram|classDiagram)\b/i.test(cleaned)
      ) {
        results.push(cleaned.slice(0, 220));
      }
      if (results.length >= 12) {
        break;
      }
    }

    return Array.from(new Set(results));
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
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

  private shouldSample(path: string, size: number, deep = false): boolean {
    if (size > (deep ? 250000 : 120000)) {
      return false;
    }
    const isKeyFile =
      path.endsWith('package.json') ||
      path.endsWith('pom.xml') ||
      path.endsWith('README.md') ||
      path.endsWith('schema.prisma') ||
      path.endsWith('main.ts') ||
      path.endsWith('App.vue') ||
      path.endsWith('app.module.ts');

    if (isKeyFile || !deep) {
      return isKeyFile;
    }

    return (
      path.endsWith('.controller.ts') ||
      path.endsWith('.service.ts') ||
      path.endsWith('.module.ts') ||
      path.endsWith('.entity.ts') ||
      path.endsWith('.dto.ts') ||
      path.endsWith('.vue') ||
      path.endsWith('.tsx') ||
      path.endsWith('.ts') ||
      path.endsWith('.jsx') ||
      path.endsWith('.js') ||
      path.endsWith('.java') ||
      path.endsWith('.kt') ||
      path.endsWith('.py') ||
      path.endsWith('.cs') ||
      path.endsWith('.go') ||
      path.endsWith('.php') ||
      path.endsWith('.sql')
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

  private renderDocuments(documents: ProjectDocument[]): string {
    if (!documents.length) {
      return 'Sin documentos cargados.';
    }
    return documents
      .slice(0, 12)
      .map(
        (document) => `### ${document.name}

${this.truncate(this.normalizeDocumentContent(document.name, document.content), 6000)}`,
      )
      .join('\n\n');
  }

  private renderDocumentBusinessContent(documents: ProjectDocument[]): string {
    return documents
      .map((document) => this.normalizeDocumentContent(document.name, document.content))
      .filter((content) => content && !this.isUnsupportedDocumentNotice(content))
      .join('\n\n');
  }

  private normalizeDocumentContent(name: string, content: string): string {
    const raw = content?.trim() ?? '';
    if (!raw) {
      return '';
    }

    const lowerName = name.toLowerCase();
    if (lowerName.endsWith('.pdf') || raw.startsWith('%PDF-')) {
      return this.unsupportedDocumentNotice(
        'PDF',
        'El contenido binario fue omitido para evitar texto corrupto en el analisis. Carga una version TXT/MD o copia el texto del PDF en el prompt si quieres que el agente lo interprete.',
      );
    }

    if (
      lowerName.endsWith('.docx') ||
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.pptx') ||
      raw.startsWith('PK\u0003\u0004')
    ) {
      return this.unsupportedDocumentNotice(
        'Office/ZIP',
        'El archivo comprimido fue omitido porque no se extrae texto automaticamente. Exporta el contenido a TXT/MD para analizarlo.',
      );
    }

    if (this.isProbablyBinary(raw)) {
      return this.unsupportedDocumentNotice(
        'binario',
        'El contenido fue omitido porque parece binario o corrupto.',
      );
    }

    return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  }

  private unsupportedDocumentNotice(kind: string, reason: string): string {
    return `[Documento ${kind} omitido]\n${reason}`;
  }

  private isUnsupportedDocumentNotice(content: string): boolean {
    return content.startsWith('[Documento ') && content.includes(' omitido]');
  }

  private isProbablyBinary(content: string): boolean {
    if (content.length < 80) {
      return false;
    }

    let suspicious = 0;
    const sample = content.slice(0, 8000);
    for (const character of sample) {
      const code = character.charCodeAt(0);
      if (
        character === '\uFFFD' ||
        code === 0 ||
        (code < 32 && character !== '\n' && character !== '\r' && character !== '\t')
      ) {
        suspicious += 1;
      }
    }

    return suspicious > 6 || suspicious / sample.length > 0.015;
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

Modo de analisis: ${scan.deep ? 'profundo' : 'rapido'}.

Cobertura: ${scan.files.length} archivos, ${scan.samples.length} muestras, ${scan.visitedDirectories} carpetas visitadas.${scan.truncated ? ' Se alcanzaron limites de seguridad del escaneo.' : ''}

Tecnologias detectadas: ${scan.technologies.join(', ') || 'pendiente de confirmar'}.

## Logica de negocio

${prompt || this.renderDocumentBusinessContent(documents) || 'Pendiente: agrega reglas de negocio, procesos, roles y restricciones.'}

## Reglas de negocio

- Toda solicitud del Agente 2 debe leer este archivo antes de proponer cambios.
- Los cambios deben registrar ticket de ejecucion.
- Las dudas se convierten en notificaciones de aprobacion.
- Cada modulo debe tener validaciones, manejo de errores, pruebas minimas y trazabilidad.
- La autenticacion inicial debe permitir cambio posterior de usuario, nombre y contrasena.

## Entidades y flujos

- Entidades detectadas: pendiente de confirmar en codigo o documentos.
- Flujo principal: usuario solicita cambio, Agente 2 genera ticket, Agente 3 audita, Agente 4 despliega.

## Arquitectura detectada

Archivos principales:

${scan.files.slice(0, 60).map((file) => `- ${file}`).join('\n') || '- Sin archivos detectados.'}

## Arquitectura tecnica recomendada

${project.targetType === 'executable' ? `Para ejecutable Java, usar Spring Boot por capas:

- Capa API: controladores REST y DTOs.
- Capa aplicacion: servicios con reglas de negocio y casos de uso.
- Capa dominio: entidades, validadores y objetos de valor.
- Capa infraestructura: persistencia, configuracion, logging y empaquetado JAR.
- Seguridad: usuario inicial por variables de entorno, hashing de contrasena y cambio obligatorio posterior.
- Testing: unitarias para reglas y pruebas de integracion para endpoints principales.` : `Para web, usar una arquitectura modular NestJS + Vue:

- API NestJS: modulos por dominio, controladores REST, servicios de aplicacion, DTOs y validadores.
- UI Vue: vistas por flujo de negocio, composables para consumo de API y estado local claro.
- Persistencia: iniciar con almacenamiento simple o SQLite, dejando contratos preparados para migrar a PostgreSQL.
- Seguridad: autenticacion, gestion de usuario inicial, hashing, validacion de DTOs, CORS controlado y limites de payload.
- Testing: unitarias de servicios, integracion de endpoints y flujo E2E de login + flujo principal.`}

## Stack de desarrollo sugerido

- Backend: ${project.targetType === 'executable' ? 'Java 17, Spring Boot, Maven, JUnit' : 'NestJS, TypeScript, DTOs, servicios modulares'}
- Frontend: ${project.targetType === 'executable' ? 'No aplica salvo consola o cliente externo' : 'Vue 3, Vite, TypeScript, CSS responsive'}
- Datos: SQLite local para prototipo; PostgreSQL recomendado para produccion.
- Calidad: pruebas automatizadas, health check, logs estructurados y configuracion por ambiente.

## Estructura de modulos y archivos esperados

${project.targetType === 'executable' ? `- pom.xml
- src/main/java/.../Application.java
- src/main/java/.../auth/AuthController.java
- src/main/java/.../business/BusinessController.java
- src/main/java/.../business/BusinessService.java
- src/main/java/.../business/BusinessRecord.java
- src/main/resources/application.properties` : `- package.json raiz con workspaces
- apps/api/src/app.module.ts
- apps/api/src/auth.controller.ts
- apps/api/src/business.controller.ts
- apps/api/src/business.service.ts
- apps/api/src/business.types.ts
- apps/web/src/App.vue
- apps/web/src/style.css
- docs/architecture.md`}

## Diagramas Mermaid

### Arquitectura de componentes

\`\`\`mermaid
flowchart LR
  Usuario[Usuario] --> UI[Vue UI]
  UI --> API[API NestJS o Java]
  API --> Auth[Modulo de autenticacion]
  API --> Business[Modulos de negocio]
  Business --> Store[(Persistencia)]
\`\`\`

### Flujo principal

\`\`\`mermaid
sequenceDiagram
  participant U as Usuario
  participant UI as Interfaz
  participant API as Backend
  participant S as Servicio de negocio
  U->>UI: Ejecuta flujo principal
  UI->>API: Envia datos validados
  API->>S: Aplica reglas de negocio
  S-->>API: Resultado o errores de validacion
  API-->>UI: Respuesta normalizada
  UI-->>U: Estado actualizado
\`\`\`

### Modelo de datos inicial

\`\`\`mermaid
erDiagram
  USER ||--o{ BUSINESS_RECORD : manages
  BUSINESS_RECORD {
    string id
    string title
    string status
    string priority
    datetime createdAt
  }
  USER {
    string id
    string username
    string displayName
  }
\`\`\`

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
- Generar o actualizar una aplicacion funcional si el proyecto es nuevo.
- Materializar reglas de negocio en controladores, servicios, DTOs, UI y documentacion.
- Mantener archivos existentes sin sobrescritura automatica cuando el proyecto no fue creado por el orquestador.

## Archivos esperados

- business-rules.md
- ticket de ejecucion
- ${targetType === 'executable' ? 'API Java/Spring Boot con endpoints de negocio y empaquetado JAR' : 'API NestJS con modulo de negocio y UI Vue operativa'}
- documentacion tecnica con diagramas y criterios de aceptacion

## Criterios de aceptacion

- El proyecto conserva memoria por SQLite propio.
- El cambio queda trazado en ticket.
- La aplicacion generada incluye flujo autenticado, modulo de negocio y comandos de ejecucion.
- El siguiente paso puede ser auditado por el Agente 3.

## Riesgos

${rules ? '- Reglas cargadas parcialmente; revisar dudas abiertas.' : '- Falta levantar reglas de negocio con el Agente 1.'}
`;
  }

  private buildTestingDeveloperPrompt(
    project: ProjectRecord,
    prompt: string,
    scan: ProjectScan,
    rules: string,
    latestTicketSummary: string,
  ): string {
    const architectureContext = this.extractSectionLines(rules, [
      'Arquitectura tecnica recomendada',
      'Arquitectura tecnica detectada y recomendada',
      'Estructura de modulos y archivos esperados',
      'Criterios tecnicos para el Agente 2',
    ]).slice(0, 10);
    const businessContext = this.extractSectionLines(rules, [
      'Reglas de negocio',
      'Entidades y flujos',
      'Logica de negocio',
    ]).slice(0, 12);
    const files = scan.files.slice(0, 80).join('\n');

    return `Actua como Agente 2 desarrollador tipo Codex para el proyecto "${project.name}".

Objetivo:
Implementa los ajustes detectados por el Agente 3 de testing y deja el proyecto en una version mas segura, mantenible y funcional. No generes solo documentacion: modifica o genera los archivos necesarios.

Contexto del proyecto:
- Tipo objetivo: ${project.targetType}
- Ruta: ${project.projectPath}
- Pedido adicional de testing: ${prompt || 'Sin pedido adicional.'}

Reglas y logica de negocio que debes respetar:
${businessContext.map((item) => `- ${item}`).join('\n') || '- Leer business-rules.md y aplicar reglas vigentes.'}

Arquitectura y modulos esperados:
${architectureContext.map((item) => `- ${item}`).join('\n') || '- Mantener arquitectura modular con API, UI, seguridad, mantenedores, reporteria y modulos propios del negocio.'}

Ultimo ticket de desarrollo:
${latestTicketSummary || 'Sin ticket previo disponible.'}

Hallazgos que debes corregir:
- Completar validaciones de DTOs y reglas de negocio por modulo.
- Fortalecer seguridad: usuarios, roles, contrasenas, CORS, secretos por ambiente y manejo de errores.
- Agregar CRUD completo para cada modulo solicitado por el usuario, no solo modulos transversales.
- Agregar reporteria operacional, dashboards, exportaciones y filtros utiles.
- Agregar mantenedores/catalogos necesarios para estados, prioridades, categorias y roles.
- Agregar pruebas unitarias o de integracion para servicios y endpoints principales.
- Revisar escalabilidad: separacion de capas, persistencia reemplazable, logs y health checks.

Archivos detectados para considerar:
${files || 'Sin archivos detectados.'}

Criterios de aceptacion:
- El proyecto compila sin errores.
- El Agente 2 crea o actualiza archivos concretos.
- Cada modulo propio del negocio tiene CRUD, validaciones, estados y reglas aplicadas.
- Seguridad, mantenedores y reporteria quedan conectados a la UI o endpoints.
- El reporte final lista archivos modificados y comandos para verificar.

Pruebas esperadas:
- Ejecutar build del backend y frontend cuando aplique.
- Probar endpoints principales de CRUD, reportes y seguridad.
- Probar flujo de login y operacion principal en la interfaz.
`;
  }

  private localTestingReport(
    project: ProjectRecord,
    prompt: string,
    scan: ProjectScan,
    rules: string,
  ): string {
    const developerPrompt = this.buildTestingDeveloperPrompt(
      project,
      prompt,
      scan,
      rules,
      '',
    );
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

## Prompt completo para Agente 2

\`\`\`text
${developerPrompt}
\`\`\`
`;
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max)}\n... [contenido truncado]`;
  }
}
