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
  mimeType?: string;
  kind?: 'text' | 'image' | 'file';
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
    documents: Array<{ name: string; content: string; mimeType?: string; kind?: 'text' | 'image' | 'file' }>,
  ): ProjectSnapshot {
    const project = this.store.getProject(projectId);
    documents.forEach((document) => {
      const content = this.normalizeDocumentContent(
        document.name,
        document.content,
        document.mimeType,
      );
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

  async approveNotification(
    projectId: string,
    notificationId: string,
  ): Promise<RunAgentResult> {
    const project = this.store.getProject(projectId);
    const notification = this.store.getNotification(project, notificationId);
    if (!notification || notification.status !== 'open') {
      throw new BadRequestException('La notificacion ya no esta disponible.');
    }

    this.store.resolveNotification(project, notificationId);
    return this.runAgent(project.id, notification.agentKey, {
      prompt: notification.message,
    });
  }

  getTestingReportPath(projectId: string): string {
    const project = this.store.getProject(projectId);
    const reportPath = this.store.getLatestTestingReportPath(project);
    if (!reportPath) {
      throw new BadRequestException('Aun no existe un reporte de testing.');
    }
    return this.store.saveTestingPdfReport(project, readFileSync(reportPath, 'utf8'));
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
          path: this.store.saveTestingPdfReport(
            project,
            readFileSync(testingReport, 'utf8'),
          ),
          fileName: `${project.slug}-tester-report.pdf`,
        };
      }
    }

    const latestRun = this.store.getLatestAgentRun(project, agentKey);
    if (!latestRun?.output?.trim()) {
      throw new BadRequestException('Aun no existe una salida generada para este agente.');
    }

    const reportPath = this.store.saveAgentOutputPdfReport(
      project,
      agentKey,
      latestRun.output,
    );

    return {
      path: reportPath,
      fileName: `${project.slug}-${agentKey}-report.pdf`,
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
        const content = this.normalizeDocumentContent(
          document.name,
          document.content,
          document.mimeType,
        );
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
    const images = this.extractImageAttachments(documents);

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
        'Eres el Agente 1, consultor senior experto en levantamiento de informacion, arquitectura de software, analisis funcional y diseno de plataformas transaccionales. Generas un markdown tecnico, accionable y suficientemente descriptivo para que un desarrollador implemente el sistema sin volver a leer todo el proyecto. No aceptas fronts demostrativos: defines modulos, pantallas, tablas, formularios, acciones, permisos, reportes y flujos transaccionales esperados.',
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
7. Mapa transaccional de modulos: menu, pantallas, tablas, formularios, acciones CRUD, filtros, exportaciones y permisos por modulo
8. Estructura de modulos y archivos esperados
9. Contrato UI/API: endpoints, servicios frontend, vistas y criterios de navegacion obligatorios
10. Diagramas Mermaid: arquitectura de componentes, flujo principal y modelo de datos
11. Criterios tecnicos para el Agente 2
12. Dudas o aprobaciones pendientes.

Definicion de terminado transaccional:
- Cada modulo solicitado debe aparecer en el menu principal o sidebar.
- Cada modulo debe tener pantalla propia, listado o tabla, filtros, formulario de creacion, accion de edicion/cambio de estado y eliminacion o anulacion cuando aplique.
- El frontend debe consumir APIs reales por modulo; no puede limitarse a cards, contadores o texto demostrativo.
- Si el sistema es ERP, debe parecer una plataforma operativa con dashboard, navegacion lateral, estado operacional, modulos de inventario/compras/ventas/clientes/proveedores/usuarios/roles/reportes y flujos transaccionales.
- El Agente 2 debe reescribir frontend o backend si la implementacion existente no cumple este contrato.

Para proyectos nuevos, propone una arquitectura completa para ${project.targetType === 'executable' ? 'Java ejecutable empaquetable en JAR' : 'NestJS + Vue'} con capas, modulos, DTOs, servicios, persistencia, autenticacion, validaciones, testing y despliegue local.`,
      fallback: () => this.localAnalysis(project, prompt, scan, documents),
      images,
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
    const documents = this.store.getDocuments(project);
    const images = this.extractImageAttachments(documents);
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

    const implementationScan = this.scanProject(updatedProject.projectPath, { deep: true });
    const developmentGap = this.buildDevelopmentGap(
      updatedProject,
      targetType,
      requestedChange,
      rules,
      implementationScan,
    );

    try {
      const aiResult = await this.ai.generate({
        system:
          'Eres el Agente 2 desarrollador senior experto en implementacion full-stack tipo Codex y arquitectura de plataformas transaccionales. Actuas como programador senior dentro de un orquestador local que SI tiene acceso al filesystem del proyecto indicado y que aplicara cambios fisicos mediante scaffold. Nunca digas que no tienes acceso a la ruta local si el inventario tecnico fue entregado. Inspeccionas archivos reales, comparas backend y frontend, detectas brechas y programas una aplicacion funcional de extremo a extremo. No basta con exponer APIs ni escribir documentacion: cada modulo solicitado debe tener backend, servicio frontend, pantalla transaccional, listado/tabla, formulario CRUD, estados/acciones, validaciones, reporteria cuando aplique y navegacion visible para el usuario. Si el front actual es demostrativo, generico o no transaccional, debes reemplazarlo o reescribirlo.',
        prompt: `Proyecto: ${updatedProject.name}
Tipo objetivo: ${targetType}

Reglas de negocio vigentes:
${this.truncate(rules, 12000)}

Inventario tecnico real del proyecto:
${developmentGap}

Muestras de archivos actuales:
${this.truncate(this.renderSamples(implementationScan), 30000)}

Documentos e imagenes adjuntas:
${this.renderDocuments(documents)}

Solicitud del usuario:
${requestedChange}

Instruccion critica:
No respondas que no tienes acceso al filesystem, que no puedes listar archivos, que no puedes ejecutar comandos reales o que solo dejas un paquete tecnico. Este orquestador local ya te entrego inventario y muestras reales, y luego aplicara el scaffold sobre la ruta fisica indicada. Tu salida debe guiar una implementacion real y auditable por archivos.

Devuelve markdown con:
1. Alcance implementado
2. Ticket de ejecucion
3. Arquitectura aplicada
4. Archivos creados o modificados
5. Brechas detectadas entre API y frontend
6. Logica de negocio implementada por modulo
7. CRUD completo por entidad detectada
8. Pantallas transaccionales creadas por modulo
9. Seguridad, usuarios, roles, validaciones y politicas iniciales
10. Mantenedores o catalogos operativos
11. Reporteria, dashboards, metricas y exportaciones
12. Endpoints y rutas frontend disponibles
13. Criterios de aceptacion
14. Pruebas sugeridas
15. Riesgos o pendientes.

Reglas obligatorias de implementacion:
- Reescribe frontend o backend cuando sea necesario; no conserves una pantalla vieja si impide cumplir el contrato transaccional.
- No generes una pagina de documentacion, cards estaticos, contadores o listas genericas como resultado final.
- El primer viewport autenticado debe ser una plataforma operativa: sidebar/menu, dashboard, modulos navegables, estado operacional, tablas y acciones.
- Si existe una API de modulo sin pantalla, debes crear o modificar el frontend para transaccionar ese modulo.
- Cada modulo solicitado debe aparecer en la navegacion visible del frontend, no solo como endpoint.
- Cada modulo debe tener listado o tabla, filtros, crear, editar o cambiar estado, eliminar/anular cuando aplique y feedback de carga/error.
- El frontend debe consumir las APIs reales del modulo, no datos hardcodeados salvo seed inicial del backend.
- Para ERP, prioriza pantallas operativas para productos, categorias, almacenes, ubicaciones, inventario, movimientos, kardex, compras, ventas, clientes, proveedores, usuarios, roles y reportes.
- No declares "implementado" un modulo si no existe evidencia en archivos backend y frontend.

No generes modulos genericos vacios. Extrae entidades, reglas, flujos, validaciones y restricciones del analisis previo y materializalos en archivos concretos. Antes de decir que algo fue implementado, valida si el archivo existe en el inventario tecnico. Si el backend existe pero el frontend no permite transaccionar, esa brecha es critica y debes resolverla. Lo que no exista debe quedar en la lista de archivos generados/modificados por el scaffold. Si el proyecto es nuevo, genera una aplicacion funcional completa segun las reglas, no solo una estructura base. Si falta detalle, implementa una version inicial coherente y marca los pendientes como dudas.`,
        fallback: () => this.localDeveloperPlan(updatedProject, targetType, requestedChange, rules),
        timeoutMs: this.getDeveloperTimeoutMs(),
        images,
      });

      const ticket = this.store.createTicket(
        updatedProject,
        `Ejecucion ${new Date().toISOString().slice(0, 10)} - ${updatedProject.name}`,
        requestedChange,
        this.normalizeDeveloperNarrative(aiResult.text, updatedProject.projectPath),
      );
      const scaffold = this.scaffolds.applyDevelopmentRequest(
        updatedProject,
        targetType,
        requestedChange,
        rules,
        ticket.id,
      );
      const developerNarrative = this.normalizeDeveloperNarrative(
        aiResult.text,
        updatedProject.projectPath,
      );
      const output = `# Resultado real de ejecucion

El orquestador local ejecuto el Agente 2 con acceso a la ruta:

\`\`\`text
${updatedProject.projectPath}
\`\`\`

No se acepta como resultado final una afirmacion de falta de acceso al filesystem cuando el scaffold genero o verifico archivos fisicos. La evidencia de ejecucion queda en la lista de archivos generados o verificados.

## Respuesta tecnica del Agente 2

${developerNarrative}

## Comparacion contra codigo existente

${developmentGap}

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
    const documents = this.store.getDocuments(project);
    const images = this.extractImageAttachments(documents);
    const snapshot = this.store.getProjectSnapshot(project.id);
    const developerPrompt = this.buildTestingDeveloperPrompt(
      project,
      prompt,
      scan,
      rules,
      snapshot.latestTicket?.summary ?? '',
    );
    const transactionalAudit = this.renderTransactionalFrontendAudit(
      scan,
      this.extractDevelopmentModules(`${prompt}\n${rules}`),
    );

    const aiResult = await this.ai.generate({
      system:
        'Eres el Agente 3, QA lead senior experto en testing, seguridad, escalabilidad, arquitectura, UX operativa y plataformas transaccionales. Auditas el proyecto con criterio profesional. No ejecutas cambios; devuelves instrucciones priorizadas. Debes marcar como hallazgo critico cualquier frontend demostrativo, generico o no transaccional.',
      prompt: `Proyecto: ${project.name}
Tipo objetivo: ${project.targetType}

Reglas de negocio:
${this.truncate(rules, 12000)}

Ultimo ticket:
${snapshot.latestTicket?.summary ?? 'Sin ticket de desarrollo.'}

Documentos e imagenes adjuntas:
${this.renderDocuments(documents)}

Arbol resumido:
${scan.files.join('\n') || 'Sin archivos detectados.'}

Auditoria transaccional del frontend:
${transactionalAudit}

Pedido adicional:
${prompt || 'Sin prompt adicional.'}

Prompt sugerido para Agente 2:
${developerPrompt}

Devuelve un reporte markdown con: Resumen, Hallazgos criticos, Frontend transaccional, Seguridad, Escalabilidad, Arquitectura sugerida, Pruebas recomendadas, Checklist para Agente 2, Prompt completo para Agente 2.

En la seccion "Prompt completo para Agente 2", incluye un bloque \`\`\`text con el prompt completo y listo para copiar. Debe contener objetivo, contexto, hallazgos, archivos/modulos a tocar, criterio obligatorio de reescritura de frontend si es demo/no transaccional, criterios de aceptacion y pruebas esperadas.`,
      fallback: () => this.localTestingReport(project, prompt, scan, rules),
      images,
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
      if (targetType === 'web') {
        const scan = this.scanProject(updatedProject.projectPath, { deep: true });
        const findings = this.getTransactionalFrontendFindings(
          scan,
          this.extractDevelopmentModules(`${prompt}\n${this.store.readBusinessRules(updatedProject)}`),
        );
        const criticalFindings = findings.filter((finding) =>
          finding.startsWith('CRITICO:'),
        );

        if (criticalFindings.length) {
          const developerPrompt = `Reescribe o completa el frontend y backend para cumplir el contrato transaccional antes del despliegue.

Hallazgos bloqueantes:
${criticalFindings.map((finding) => `- ${finding}`).join('\n')}

Criterios obligatorios:
- Sidebar/menu operativo por modulo.
- Dashboard ejecutivo con metricas reales.
- Pantalla transaccional por cada modulo solicitado.
- Tabla o listado con filtros.
- Formulario de creacion.
- Accion de edicion o cambio de estado.
- Accion de eliminacion/anulacion cuando aplique.
- Servicios frontend consumiendo APIs reales por modulo.
- Reescribir App.vue, servicios, vistas y backend si la implementacion actual es demostrativa.`;
          const output = `# Despliegue bloqueado por validacion transaccional

El Agente 4 no levantara la aplicacion como finalizada porque el frontend aun no cumple el contrato minimo de plataforma transaccional.

## Hallazgos

${criticalFindings.map((finding) => `- ${finding}`).join('\n')}

## Prompt para aprobar en Agente 2

\`\`\`text
${developerPrompt}
\`\`\`
`;

          this.store.addNotification(
            updatedProject,
            'developer',
            developerPrompt,
            'approval',
          );
          this.store.finishRun(updatedProject, runId, 'deployment', 'Sugiriendo', output);

          return {
            project: this.store.getProjectSnapshot(updatedProject.id),
            output,
          };
        }
      }

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

  private normalizeDeveloperNarrative(text: string, projectPath: string): string {
    const normalized = this.normalizeText(text);
    const deniesAccess =
      normalized.includes('no tengo acceso directo al filesystem') ||
      normalized.includes('no puedo ejecutar comandos reales') ||
      normalized.includes('no puedo modificar archivos fisicamente') ||
      normalized.includes('no declaro implementado ningun cambio en disco');

    if (!deniesAccess) {
      return text;
    }

    return `# Ejecucion corregida del Agente desarrollador

El modelo produjo una respuesta conservadora indicando falta de acceso al filesystem. Esa afirmacion no aplica en este orquestador local.

Ruta disponible para ejecucion:

\`\`\`text
${projectPath}
\`\`\`

El Agente 2 debe continuar como programador senior full-stack: revisar backend y frontend, detectar brechas API/UI, generar o modificar archivos reales mediante el scaffold local y reportar solo lo que quede respaldado por archivos generados o verificados.`;
  }

  private buildDevelopmentGap(
    project: ProjectRecord,
    targetType: ProjectTarget,
    prompt: string,
    rules: string,
    scan: ProjectScan,
  ): string {
    const files = new Set(scan.files.map((file) => file.replace(/\\/g, '/')));
    const modules = this.extractDevelopmentModules(`${prompt}\n${rules}`);
    const expected =
      targetType === 'executable'
        ? [
            'pom.xml',
            'src/main/java/com/agents/generated/Application.java',
            'src/main/java/com/agents/generated/AuthController.java',
            'src/main/java/com/agents/generated/BusinessController.java',
            'src/main/java/com/agents/generated/BusinessService.java',
            'src/main/resources/application.properties',
          ]
        : [
            'package.json',
            'apps/api/package.json',
            'apps/api/src/main.ts',
            'apps/api/src/app.module.ts',
            'apps/api/src/auth.controller.ts',
            'apps/api/src/business.controller.ts',
            'apps/api/src/business.service.ts',
            'apps/api/src/business.types.ts',
            'apps/api/src/application-modules.controller.ts',
            'apps/api/src/application-modules.service.ts',
            'apps/api/src/maintainers.controller.ts',
            'apps/api/src/reports.controller.ts',
            'apps/api/src/security.controller.ts',
            'apps/web/package.json',
            'apps/web/src/App.vue',
            'apps/web/src/main.ts',
            'docs/architecture.md',
            ...modules.flatMap((module) => [
              `apps/api/src/domain/${module}/${module}.controller.ts`,
              `apps/api/src/domain/${module}/${module}.service.ts`,
              `apps/api/src/domain/${module}/${module}.types.ts`,
              `apps/web/src/modules/${module}/${module}.vue`,
              `apps/web/src/services/${module}.service.ts`,
            ]),
          ];

    const existing = expected.filter((file) => files.has(file));
    const missing = expected.filter((file) => !files.has(file));
    const controllers = scan.files.filter((file) => file.endsWith('.controller.ts'));
    const services = scan.files.filter((file) => file.endsWith('.service.ts'));
    const views = scan.files.filter((file) => file.endsWith('.vue') || file.endsWith('.tsx'));
    const backendModules = modules.filter((module) =>
      files.has(`apps/api/src/domain/${module}/${module}.controller.ts`),
    );
    const frontendModules = modules.filter(
      (module) =>
        files.has(`apps/web/src/modules/${module}/${module}.vue`) ||
        scan.samples.some(
          (sample) =>
            sample.path === 'apps/web/src/App.vue' &&
            sample.content.toLowerCase().includes(module.replace(/-/g, ' ')),
        ),
    );
    const apiWithoutFrontend = backendModules.filter(
      (module) => !frontendModules.includes(module),
    );
    const transactionalAudit = this.renderTransactionalFrontendAudit(scan, modules);

    return `### Inventario de implementacion

- Tecnologia detectada: ${scan.technologies.join(', ') || 'sin detectar'}.
- Archivos revisados: ${scan.files.length}.
- Controladores existentes: ${controllers.length ? controllers.slice(0, 20).join(', ') : 'ninguno'}.
- Servicios existentes: ${services.length ? services.slice(0, 20).join(', ') : 'ninguno'}.
- Vistas existentes: ${views.length ? views.slice(0, 20).join(', ') : 'ninguna'}.
- Modulos con backend detectado: ${backendModules.length ? backendModules.join(', ') : 'ninguno'}.
- Modulos con frontend transaccional detectado: ${frontendModules.length ? frontendModules.join(', ') : 'ninguno'}.

### Modulos de negocio inferidos

${modules.map((module) => `- ${module}`).join('\n') || '- business-records'}

### Brechas criticas API vs Frontend

${apiWithoutFrontend.length ? apiWithoutFrontend.map((module) => `- ${module}: API detectada sin pantalla transaccional dedicada. El Agente 2 debe crear vista, servicio HTTP, formulario CRUD, listado y navegacion.`).join('\n') : '- No se detectaron APIs sin frontend para los modulos inferidos.'}

### Auditoria transaccional del frontend

${transactionalAudit}

### Archivos esperados ya existentes

${existing.map((file) => `- ${file}`).join('\n') || '- Ninguno de los archivos esperados existe todavia.'}

### Archivos faltantes que el Agente 2 debe crear o modificar

${missing.map((file) => `- ${file}`).join('\n') || '- No se detectan archivos esperados faltantes.'}

### Regla operativa

El Agente 2 no debe declarar una API, pantalla, CRUD o modulo como implementado si no aparece en archivos reales generados o modificados. Exponer una API no es suficiente: el frontend debe permitir transaccionar cada modulo solicitado. Si falta, debe crearlo o actualizar el scaffold para materializarlo.`;
  }

  private renderTransactionalFrontendAudit(
    scan: ProjectScan,
    modules: string[],
  ): string {
    const findings = this.getTransactionalFrontendFindings(scan, modules);
    return findings.map((finding) => `- ${finding}`).join('\n');
  }

  private getTransactionalFrontendFindings(
    scan: ProjectScan,
    modules: string[],
  ): string[] {
    const files = new Set(scan.files.map((file) => file.replace(/\\/g, '/')));
    const app = scan.samples.find((sample) => sample.path === 'apps/web/src/App.vue');
    const appContent = app?.content ?? '';
    const normalizedApp = this.normalizeText(appContent);
    const moduleViews = scan.files.filter((file) =>
      /^apps\/web\/src\/modules\/.+\/.+\.(vue|tsx)$/.test(file.replace(/\\/g, '/')),
    );
    const moduleServices = scan.files.filter((file) =>
      /^apps\/web\/src\/services\/.+\.service\.ts$/.test(file.replace(/\\/g, '/')),
    );
    const hasSidebar = /sidebar|side-nav|nav-menu|menu transaccional|erp-layout/i.test(appContent);
    const hasModuleImports = /src\/modules|\.\/modules\//i.test(appContent);
    const hasActions =
      /editar|eliminar|guardar|actualizar|crear|@click=.*remove|@click=.*update|method:\s*'PUT'|method:\s*'DELETE'/i.test(
        appContent,
      ) ||
      scan.samples.some((sample) =>
        /editar|eliminar|guardar|actualizar|crear|method:\s*'PUT'|method:\s*'DELETE'/i.test(
          sample.content,
        ),
      );
    const hasForm = /<form|v-model=/i.test(appContent) || scan.samples.some((sample) => /<form|v-model=/i.test(sample.content));
    const hasApiConsumption =
      /fetch\('\/api|fetch\(\"\/api|VITE_API_URL|request<|axios/i.test(appContent) ||
      scan.samples.some((sample) => /fetch\('\/api|fetch\(\"\/api|VITE_API_URL|request<|axios/i.test(sample.content));
    const hasTablesOrRows =
      /<table|<thead|<tbody|record-card|module-table|data-table/i.test(appContent) ||
      scan.samples.some((sample) => /<table|<thead|<tbody|record-card|module-table|data-table/i.test(sample.content));
    const hasGenericDemo =
      /modulos erp operativos|nuevo registro del modulo|\{\{\s*module\.name\s*\}\}\s*-\s*\{\{\s*module\.totalRecords/i.test(
        normalizedApp,
      );
    const missingModuleScreens = modules.filter(
      (module) => !files.has(`apps/web/src/modules/${module}/${module}.vue`),
    );
    const findings: string[] = [];

    if (!app) {
      findings.push('CRITICO: no se encontro apps/web/src/App.vue para validar la experiencia transaccional.');
    }
    if (!hasSidebar) {
      findings.push('CRITICO: el frontend no evidencia sidebar/menu operativo por modulos como una plataforma real.');
    }
    if (!hasModuleImports || moduleViews.length === 0) {
      findings.push('CRITICO: el frontend no importa ni monta vistas reales por modulo desde apps/web/src/modules.');
    }
    if (missingModuleScreens.length) {
      findings.push(
        `CRITICO: faltan pantallas transaccionales para: ${missingModuleScreens.join(', ')}.`,
      );
    }
    if (!hasApiConsumption || moduleServices.length === 0) {
      findings.push('CRITICO: no se detectan servicios frontend consumiendo APIs reales por modulo.');
    }
    if (!hasForm || !hasActions || !hasTablesOrRows) {
      findings.push(
        'CRITICO: la UI no evidencia CRUD completo visible: listado/tabla, formulario, crear, actualizar/cambiar estado y eliminar.',
      );
    }
    if (hasGenericDemo) {
      findings.push(
        'CRITICO: se detecto UI generica o demostrativa. Debe reemplazarse por shell transaccional con sidebar, dashboard y pantallas reales por modulo.',
      );
    }
    if (!findings.length) {
      findings.push(
        'OK: se detectan señales minimas de frontend transaccional con navegacion, vistas por modulo, servicios API y acciones CRUD.',
      );
    }

    return findings;
  }

  private extractDevelopmentModules(source: string): string[] {
    const normalized = this.normalizeText(source);
    const knownModules = [
      ['usuarios', 'usuarios'],
      ['roles', 'roles'],
      ['permisos', 'permisos'],
      ['productos', 'productos'],
      ['categorias', 'categorias-producto'],
      ['almacenes', 'almacenes'],
      ['ubicaciones', 'ubicaciones-almacen'],
      ['inventario', 'inventario'],
      ['movimientos', 'movimientos-inventario'],
      ['kardex', 'kardex'],
      ['auditoria', 'auditoria'],
      ['reportes', 'reportes'],
      ['clientes', 'clientes'],
      ['proveedores', 'proveedores'],
      ['compras', 'compras'],
      ['ventas', 'ventas'],
      ['pedidos', 'pedidos'],
      ['facturas', 'facturas'],
      ['ticket', 'tickets'],
      ['despliegue', 'despliegues'],
      ['notificacion', 'notificaciones'],
    ] as const;

    const detected = knownModules
      .filter(([term]) => normalized.includes(term))
      .map(([, slug]) => slug);

    return Array.from(new Set(detected)).slice(0, 18);
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

${this.formatDocumentForPrompt(document)}`,
      )
      .join('\n\n');
  }

  private renderDocumentBusinessContent(documents: ProjectDocument[]): string {
    return documents
      .map((document) => this.formatDocumentForPrompt(document))
      .filter((content) => content && !this.isUnsupportedDocumentNotice(content))
      .join('\n\n');
  }

  private formatDocumentForPrompt(document: ProjectDocument): string {
    if (this.isImageDocument(document.content)) {
      const meta = this.parseImageDocument(document.content);
      return `[Imagen adjunta para analisis visual]
Nombre: ${meta.name || document.name}
Tipo: ${meta.mimeType}
Uso esperado: interpretar pantallas, mockups, diagramas, formularios, flujos o referencias visuales junto con el prompt del usuario.`;
    }

    return this.truncate(
      this.normalizeDocumentContent(document.name, document.content, document.mimeType),
      6000,
    );
  }

  private extractImageAttachments(
    documents: ProjectDocument[],
  ): Array<{ name: string; mimeType: string; dataUrl: string }> {
    return documents
      .filter((document) => this.isImageDocument(document.content))
      .map((document) => {
        const meta = this.parseImageDocument(document.content);
        return {
          name: meta.name || document.name,
          mimeType: meta.mimeType,
          dataUrl: meta.dataUrl,
        };
      })
      .filter((image) => image.dataUrl.startsWith('data:image/'))
      .slice(0, 6);
  }

  private isImageDocument(content: string): boolean {
    return content.startsWith('[Imagen adjunta]') && content.includes('Contenido: data:image/');
  }

  private parseImageDocument(content: string): {
    name: string;
    mimeType: string;
    dataUrl: string;
  } {
    return {
      name: content.match(/^Nombre:\s*(.+)$/m)?.[1]?.trim() ?? '',
      mimeType: content.match(/^Tipo:\s*(.+)$/m)?.[1]?.trim() ?? 'image/png',
      dataUrl: content.match(/^Contenido:\s*(data:image\/[^\s]+)$/m)?.[1]?.trim() ?? '',
    };
  }

  private normalizeDocumentContent(
    name: string,
    content: string,
    mimeType?: string,
  ): string {
    const raw = content?.trim() ?? '';
    if (!raw) {
      return '';
    }

    const lowerName = name.toLowerCase();
    const type = mimeType?.toLowerCase() ?? '';
    if (type.startsWith('image/') || raw.startsWith('data:image/')) {
      const imageType = type || raw.match(/^data:([^;]+);base64,/)?.[1] || 'image/*';
      return `[Imagen adjunta]
Nombre: ${name}
Tipo: ${imageType}
Contenido: ${raw}`;
    }

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
- Cada modulo debe tener pantalla transaccional propia con menu visible, tabla/listado, filtros, formulario, acciones de editar/cambiar estado y eliminar/anular cuando aplique.
- El frontend no puede quedarse en cards demostrativos, contadores o listas genericas de modulos.
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
- UI transaccional: sidebar/menu por modulo, dashboard operativo, tablas, filtros, formularios, estados de carga/error, acciones por fila y consumo real de endpoints.
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
- apps/web/src/modules/<modulo>/<modulo>.vue
- apps/web/src/services/<modulo>.service.ts
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
- Reescribir el frontend o backend si lo existente es generico, demostrativo o no permite transaccionar modulos.
- Revisar backend y frontend antes de declarar avances.
- Materializar reglas de negocio en controladores, servicios, DTOs, servicios HTTP frontend, pantallas transaccionales, formularios, listados y navegacion.
- Si una API ya existe pero no hay UI para transaccionarla, crear la pantalla, el servicio frontend y la ruta/menu correspondiente.
- Para ERP, cada modulo solicitado debe poder operarse desde la interfaz: productos, categorias, almacenes, ubicaciones, inventario, movimientos, kardex, compras, ventas, clientes, proveedores, usuarios, roles y reportes.
- Mantener archivos existentes sin sobrescritura automatica cuando el proyecto no fue creado por el orquestador.

## Archivos esperados

- business-rules.md
- ticket de ejecucion
- ${targetType === 'executable' ? 'API Java/Spring Boot con endpoints de negocio y empaquetado JAR' : 'API NestJS con modulo de negocio y UI Vue operativa'}
- servicios frontend por modulo
- pantallas transaccionales por modulo solicitado con tabla/listado, filtros, formulario, editar/cambiar estado y eliminar/anular
- navegacion visible para cada modulo en sidebar/menu principal
- dashboard operativo tipo plataforma real, no cards demostrativos
- documentacion tecnica con diagramas y criterios de aceptacion

## Criterios de aceptacion

- El proyecto conserva memoria por SQLite propio.
- El cambio queda trazado en ticket.
- La aplicacion generada incluye flujo autenticado, modulos de negocio operables desde frontend y comandos de ejecucion.
- Ningun modulo debe quedar solo como endpoint sin pantalla transaccional.
- No debe quedar un front con datos demostrativos, listas genericas o pantalla de documentacion.
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
    const modules = this.extractDevelopmentModules(`${prompt}\n${rules}`);
    const transactionalAudit = this.renderTransactionalFrontendAudit(scan, modules);
    const files = scan.files.slice(0, 80).join('\n');

return `Actua como Agente 2 desarrollador tipo Codex para el proyecto "${project.name}".

Objetivo:
Implementa los ajustes detectados por el Agente 3 de testing y deja el proyecto en una version mas segura, mantenible y funcional. Actua como programador senior full-stack. No generes solo documentacion: modifica o genera backend, servicios frontend, pantallas, formularios, listados/tablas, navegacion, validaciones y pruebas. Si el frontend actual es demostrativo o no transaccional, reescribelo.

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

Auditoria transaccional actual:
${transactionalAudit}

Hallazgos que debes corregir:
- Reemplazar cualquier pantalla generica tipo cards/contadores/lista de modulos por una shell transaccional con sidebar, dashboard, tablas, formularios y acciones reales.
- Completar validaciones de DTOs y reglas de negocio por modulo.
- Fortalecer seguridad: usuarios, roles, contrasenas, CORS, secretos por ambiente y manejo de errores.
- Agregar CRUD completo para cada modulo solicitado por el usuario, no solo modulos transversales.
- Verificar que cada modulo expuesto por API tenga una pantalla frontend transaccional.
- Si hay backend sin frontend, crear componentes/vistas/servicios frontend y enlazarlos en la navegacion.
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
- Cada modulo propio del negocio tiene pantalla transaccional visible en frontend.
- El frontend autenticado se parece a una plataforma operativa real: menu lateral, dashboard, secciones por modulo, tablas, filtros, formularios, acciones y estados de carga/error.
- No quedan textos o flujos de demo como "Proyecto ERP", "Modulos ERP operativos" o "Nuevo registro del modulo" si no abren pantallas transaccionales reales.
- Seguridad, mantenedores y reporteria quedan conectados a la UI y a endpoints reales.
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
- Si el frontend muestra cards, contadores o modulos genericos sin pantallas transaccionales, debe considerarse bloqueo critico y volver al Agente 2.

## Seguridad

- Rotar la contrasena default despues del primer acceso.
- Agregar hashing de contrasenas y control de sesiones si existe login.
- Revisar CORS, limites de payload y validacion de DTOs.

## Escalabilidad

- Separar configuracion por ambiente.
- Agregar logs estructurados y health checks.
- Definir estrategia de base de datos antes de crecer en usuarios.

## Arquitectura sugerida

${project.targetType === 'executable' ? '- Para Java, empaquetar jar reproducible y externalizar configuracion.' : '- Para web, mantener API NestJS separada de UI Vue y compartir contratos por DTOs. La UI debe ser una plataforma transaccional con sidebar, dashboard, vistas por modulo, tablas, filtros, formularios y acciones por fila.'}

## Pruebas recomendadas

- Unitarias para reglas de negocio.
- Integracion para endpoints criticos.
- E2E minimo de login y flujo principal.
- E2E de cada modulo solicitado: abrir desde menu, listar, crear, editar/cambiar estado, eliminar/anular y ver reporte.

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
