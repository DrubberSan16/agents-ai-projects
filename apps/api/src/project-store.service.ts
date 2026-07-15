import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_KEYS,
  AgentKey,
  AgentState,
  AgentStatus,
  CreateProjectInput,
  DeploymentInfo,
  DevelopmentTicket,
  ProjectNotification,
  ProjectRecord,
  ProjectSnapshot,
  ProjectTarget,
} from './orchestrator.types';

@Injectable()
export class ProjectStoreService {
  private readonly storageRoot: string;
  private readonly projectMetaRoot: string;
  private readonly indexPath: string;

  constructor(private readonly configService: ConfigService) {
    const configuredStorage = this.configService.get<string>(
      'ORCHESTRATOR_STORAGE_DIR',
    );
    this.storageRoot = resolve(configuredStorage ?? join(process.cwd(), 'storage'));
    this.projectMetaRoot = join(this.storageRoot, 'projects');
    this.indexPath = join(this.storageRoot, 'projects.index.json');
    this.ensureDirectory(this.projectMetaRoot);
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, '[]\n', 'utf8');
    }
  }

  createProject(input: CreateProjectInput): ProjectSnapshot {
    const mode = input.mode ?? 'new';
    const sourcePath = input.path?.trim() ? resolve(input.path.trim()) : undefined;
    const name =
      mode === 'existing' && sourcePath
        ? basename(sourcePath)
        : input.name?.trim();
    if (!name) {
      throw new BadRequestException('El proyecto necesita un nombre.');
    }

    if (
      mode === 'existing' &&
      (!sourcePath || !existsSync(sourcePath) || !statSync(sourcePath).isDirectory())
    ) {
      throw new BadRequestException(
        sourcePath
          ? 'La ruta seleccionada no existe o no es una carpeta.'
          : 'Selecciona la ruta donde esta alojado el proyecto.',
      );
    }

    const targetType = input.targetType ?? 'unknown';
    const slug = this.uniqueSlug(name);
    const id = this.createId('project');
    const metaDir = join(this.projectMetaRoot, id);
    const now = new Date().toISOString();
    const serverRoot =
      mode === 'new'
        ? this.configService.get<string>('NEW_PROJECTS_ROOT') ?? '/opt/projects-ai'
        : this.configService.get<string>('EXISTING_PROJECTS_ROOT') ??
          '/opt/projects-ai-mejora';
    const timestampDir = this.createTimestampDirectory(resolve(serverRoot));
    const folderName =
      mode === 'new' ? this.serverFolderName(name) : basename(sourcePath ?? '');
    const projectPath = join(timestampDir, folderName);

    if (mode === 'existing') {
      cpSync(sourcePath!, projectPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      this.ensureDirectory(projectPath);
    }

    this.ensureDirectory(metaDir);
    const agentDir = this.ensureAgentDirectory(projectPath);
    const rulesPath = join(agentDir, 'business-rules.md');
    const sqlitePath = join(metaDir, 'memory.sqlite');

    const project: ProjectRecord = {
      id,
      name,
      slug,
      mode,
      targetType,
      projectPath,
      sqlitePath,
      rulesPath,
      createdAt: now,
      updatedAt: now,
    };

    this.initProjectDatabase(sqlitePath);
    if (input.businessRules?.trim()) {
      this.writeBusinessRules(
        project,
        this.renderInitialRules(project, input.businessRules.trim()),
      );
      this.remember(project, 'business-rules', input.businessRules.trim(), {
        source: 'project-create',
      });
    } else if (!existsSync(rulesPath)) {
      writeFileSync(rulesPath, this.renderInitialRules(project, ''), 'utf8');
    }

    const projects = this.readIndex();
    projects.push(project);
    this.writeIndex(projects);
    return this.getProjectSnapshot(id);
  }

  listProjects(): ProjectSnapshot[] {
    return this.readIndex().map((project) => this.toSnapshot(project));
  }

  getProjectSnapshot(projectId: string): ProjectSnapshot {
    const project = this.getProject(projectId);
    return this.toSnapshot(project);
  }

  getProject(projectId: string): ProjectRecord {
    const project = this.readIndex().find((item) => item.id === projectId);
    if (!project) {
      throw new NotFoundException('Proyecto no encontrado.');
    }
    return project;
  }

  updateProject(project: ProjectRecord): void {
    const now = new Date().toISOString();
    const projects = this.readIndex().map((item) =>
      item.id === project.id ? { ...project, updatedAt: now } : item,
    );
    this.writeIndex(projects);
  }

  updateTarget(project: ProjectRecord, targetType: ProjectTarget): ProjectRecord {
    const updated = { ...project, targetType };
    this.updateProject(updated);
    return updated;
  }

  addDocument(
    project: ProjectRecord,
    name: string,
    content: string,
  ): { id: string; path: string } {
    const safeName = this.safeFileName(name || 'documento.txt');
    const documentDir = join(this.ensureAgentDirectory(project.projectPath), 'documents');
    this.ensureDirectory(documentDir);
    const id = this.createId('doc');
    const filePath = join(documentDir, `${id}-${safeName}`);
    writeFileSync(filePath, content, 'utf8');

    const now = new Date().toISOString();
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO documents (id, name, filePath, content, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, name, filePath, content.slice(0, 150000), now);
    });

    return { id, path: filePath };
  }

  getDocuments(project: ProjectRecord): Array<{
    id: string;
    name: string;
    content: string;
    createdAt: string;
  }> {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, name, content, createdAt
           FROM documents
           ORDER BY createdAt DESC`,
        )
        .all() as Array<{
        id: string;
        name: string;
        content: string;
        createdAt: string;
      }>,
    );
  }

  setAgentStatus(
    project: ProjectRecord,
    key: AgentKey,
    status: AgentStatus,
    summary = '',
    lastRunId?: string,
  ): void {
    const now = new Date().toISOString();
    const sortOrder = AGENT_KEYS.indexOf(key);
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO agent_states
          (key, sortOrder, status, summary, lastRunId, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           sortOrder = excluded.sortOrder,
           status = excluded.status,
           summary = excluded.summary,
           lastRunId = COALESCE(excluded.lastRunId, agent_states.lastRunId),
           updatedAt = excluded.updatedAt`,
      ).run(key, sortOrder, status, summary, lastRunId ?? null, now);
    });
  }

  createRun(project: ProjectRecord, agentKey: AgentKey, prompt: string): string {
    const id = this.createId('run');
    const now = new Date().toISOString();
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO agent_runs
          (id, agentKey, status, prompt, output, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, agentKey, 'Procesando', prompt, '', now, now);
    });
    this.setAgentStatus(project, agentKey, 'Procesando', 'Ejecutando agente.', id);
    return id;
  }

  finishRun(
    project: ProjectRecord,
    runId: string,
    agentKey: AgentKey,
    status: AgentStatus,
    output: string,
    options: { reportPath?: string; ticketId?: string } = {},
  ): void {
    const now = new Date().toISOString();
    this.withDb(project, (db) => {
      db.prepare(
        `UPDATE agent_runs
         SET status = ?, output = ?, reportPath = ?, ticketId = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(
        status,
        output,
        options.reportPath ?? null,
        options.ticketId ?? null,
        now,
        runId,
      );
    });
    this.setAgentStatus(project, agentKey, status, this.firstLine(output), runId);
  }

  remember(
    project: ProjectRecord,
    type: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): void {
    const id = this.createId('mem');
    const now = new Date().toISOString();
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO memories (id, type, content, metadata, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, type, content, JSON.stringify(metadata), now);
    });
  }

  createTicket(
    project: ProjectRecord,
    title: string,
    prompt: string,
    summary: string,
  ): DevelopmentTicket {
    const id = this.createId('ticket');
    const now = new Date().toISOString();
    const ticketDir = join(this.ensureAgentDirectory(project.projectPath), 'tickets');
    this.ensureDirectory(ticketDir);
    const filePath = join(ticketDir, `${id}.md`);
    const ticket: DevelopmentTicket = {
      id,
      title,
      status: 'Abierto',
      prompt,
      summary,
      filePath,
      createdAt: now,
      updatedAt: now,
    };
    writeFileSync(filePath, this.renderTicket(project, ticket), 'utf8');

    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO tickets
          (id, title, status, prompt, summary, filePath, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ticket.id,
        ticket.title,
        ticket.status,
        ticket.prompt,
        ticket.summary,
        ticket.filePath ?? null,
        ticket.createdAt,
        ticket.updatedAt,
      );
    });

    return ticket;
  }

  saveReport(project: ProjectRecord, content: string): string {
    const reportDir = join(this.ensureAgentDirectory(project.projectPath), 'reports');
    this.ensureDirectory(reportDir);
    const reportPath = join(reportDir, 'testing-report.md');
    writeFileSync(reportPath, content, 'utf8');
    this.remember(project, 'testing-report', content, { reportPath });
    return reportPath;
  }

  getLatestTestingReportPath(project: ProjectRecord): string | undefined {
    const row = this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT reportPath
           FROM agent_runs
           WHERE agentKey = 'tester' AND reportPath IS NOT NULL
           ORDER BY updatedAt DESC
           LIMIT 1`,
        )
        .get() as { reportPath?: string } | undefined,
    );
    if (row?.reportPath && existsSync(row.reportPath)) {
      return row.reportPath;
    }
    const reportPath = join(
      this.ensureAgentDirectory(project.projectPath),
      'reports',
      'testing-report.md',
    );
    return existsSync(reportPath) ? reportPath : undefined;
  }

  getLatestAgentRun(
    project: ProjectRecord,
    agentKey: AgentKey,
  ):
    | {
        id: string;
        agentKey: AgentKey;
        output: string;
        reportPath?: string;
        updatedAt: string;
      }
    | undefined {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, agentKey, output, reportPath, updatedAt
           FROM agent_runs
           WHERE agentKey = ? AND TRIM(output) != ''
           ORDER BY updatedAt DESC
           LIMIT 1`,
        )
        .get(agentKey) as
        | {
            id: string;
            agentKey: AgentKey;
            output: string;
            reportPath?: string;
            updatedAt: string;
          }
        | undefined,
    );
  }

  saveAgentOutputReport(
    project: ProjectRecord,
    agentKey: AgentKey,
    content: string,
  ): string {
    const reportDir = join(this.ensureAgentDirectory(project.projectPath), 'reports');
    this.ensureDirectory(reportDir);
    const reportPath = join(reportDir, `${agentKey}-latest-report.md`);
    writeFileSync(reportPath, content, 'utf8');
    return reportPath;
  }

  saveTestingPdfReport(project: ProjectRecord, content: string): string {
    return this.savePdfReport(project, 'testing-report', 'Reporte de Testing', content);
  }

  saveAgentOutputPdfReport(
    project: ProjectRecord,
    agentKey: AgentKey,
    content: string,
  ): string {
    return this.savePdfReport(
      project,
      `${agentKey}-latest-report`,
      `Reporte ${agentKey}`,
      content,
    );
  }

  savePdfReport(
    project: ProjectRecord,
    fileBaseName: string,
    title: string,
    content: string,
  ): string {
    const reportDir = join(this.ensureAgentDirectory(project.projectPath), 'reports');
    this.ensureDirectory(reportDir);
    const safeBaseName = this.safeFileName(fileBaseName).replace(/\.pdf$/i, '');
    const reportPath = join(reportDir, `${safeBaseName}.pdf`);
    this.writePdfReport(
      reportPath,
      `${title} - ${project.name}`,
      `Proyecto: ${project.name}\nRuta: ${project.projectPath}\nGenerado: ${new Date().toISOString()}\n\n${content}`,
    );
    return reportPath;
  }

  saveDeployment(
    project: ProjectRecord,
    deployment: Omit<DeploymentInfo, 'id' | 'createdAt'>,
  ): DeploymentInfo {
    const item: DeploymentInfo = {
      ...deployment,
      id: this.createId('deploy'),
      createdAt: new Date().toISOString(),
    };
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO deployments
          (id, port, url, username, password, status, command, logs, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.port,
        item.url,
        item.username,
        item.password,
        item.status,
        item.command,
        item.logs,
        item.createdAt,
      );
    });
    return item;
  }

  addNotification(
    project: ProjectRecord,
    agentKey: AgentKey,
    message: string,
    level: ProjectNotification['level'] = 'warning',
  ): ProjectNotification {
    const item: ProjectNotification = {
      id: this.createId('note'),
      agentKey,
      level,
      message,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.withDb(project, (db) => {
      db.prepare(
        `INSERT INTO notifications
          (id, agentKey, level, message, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.agentKey,
        item.level,
        item.message,
        item.status,
        item.createdAt,
      );
    });
    return item;
  }

  getNotification(
    project: ProjectRecord,
    notificationId: string,
  ): ProjectNotification | undefined {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, agentKey, level, message, status, createdAt
           FROM notifications
           WHERE id = ?
           LIMIT 1`,
        )
        .get(notificationId) as ProjectNotification | undefined,
    );
  }

  resolveNotification(project: ProjectRecord, notificationId: string): void {
    this.withDb(project, (db) => {
      db.prepare(
        `UPDATE notifications
         SET status = 'resolved'
         WHERE id = ?`,
      ).run(notificationId);
    });
  }

  resolveOpenNotifications(
    project: ProjectRecord,
    agentKey: AgentKey,
    messageContains: string,
  ): void {
    this.withDb(project, (db) => {
      db.prepare(
        `UPDATE notifications
         SET status = 'resolved'
         WHERE agentKey = ?
           AND status = 'open'
           AND message LIKE ?`,
      ).run(agentKey, `%${messageContains}%`);
    });
  }

  readBusinessRules(project: ProjectRecord): string {
    if (!existsSync(project.rulesPath)) {
      return '';
    }
    return readFileSync(project.rulesPath, 'utf8');
  }

  writeBusinessRules(project: ProjectRecord, content: string): void {
    this.ensureDirectory(dirname(project.rulesPath));
    writeFileSync(project.rulesPath, content, 'utf8');
    this.remember(project, 'business-rules', content, {
      rulesPath: project.rulesPath,
    });
  }

  ensureAgentDirectory(projectPath: string): string {
    const agentDir = join(projectPath, '.agents-ai');
    this.ensureDirectory(agentDir);
    return agentDir;
  }

  private toSnapshot(project: ProjectRecord): ProjectSnapshot {
    this.initProjectDatabase(project.sqlitePath);
    const agents = this.getAgentStates(project);
    const notifications = this.getNotifications(project);
    const latestTicket = this.getLatestTicket(project);
    const latestDeployment = this.getLatestDeployment(project);
    const hasTestingReport = Boolean(this.getLatestTestingReportPath(project));
    const documentCount = this.getDocumentCount(project);
    const { projectPath, sqlitePath, rulesPath, ...publicProject } = project;
    return {
      ...publicProject,
      agents,
      notifications,
      latestTicket,
      latestDeployment,
      hasTestingReport,
      documentCount,
    };
  }

  private getAgentStates(project: ProjectRecord): AgentState[] {
    const rows = this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT key, status, summary, lastRunId, updatedAt
           FROM agent_states
           ORDER BY sortOrder ASC`,
        )
        .all() as Array<{
        key: AgentKey;
        status: AgentStatus;
        summary: string;
        lastRunId?: string;
        updatedAt: string;
      }>,
    );
    return rows.map((row) => ({
      key: row.key,
      status: row.status,
      summary: row.summary ?? '',
      lastRunId: row.lastRunId,
      updatedAt: row.updatedAt,
    }));
  }

  private getNotifications(project: ProjectRecord): ProjectNotification[] {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, agentKey, level, message, status, createdAt
           FROM notifications
           WHERE status = 'open'
           ORDER BY createdAt DESC`,
        )
        .all() as unknown as ProjectNotification[],
    );
  }

  private getLatestTicket(project: ProjectRecord): DevelopmentTicket | undefined {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, title, status, prompt, summary, filePath, createdAt, updatedAt
           FROM tickets
           ORDER BY createdAt DESC
           LIMIT 1`,
        )
        .get() as DevelopmentTicket | undefined,
    );
  }

  private getLatestDeployment(project: ProjectRecord): DeploymentInfo | undefined {
    return this.withDb(project, (db) =>
      db
        .prepare(
          `SELECT id, port, url, username, password, status, command, logs, createdAt
           FROM deployments
           ORDER BY createdAt DESC
           LIMIT 1`,
        )
        .get() as DeploymentInfo | undefined,
    );
  }

  private getDocumentCount(project: ProjectRecord): number {
    const row = this.withDb(project, (db) =>
      db
        .prepare(`SELECT COUNT(*) AS count FROM documents`)
        .get() as { count: number },
    );
    return row.count;
  }

  private initProjectDatabase(sqlitePath: string): void {
    this.ensureDirectory(dirname(sqlitePath));
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_states (
          key TEXT PRIMARY KEY,
          sortOrder INTEGER NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          lastRunId TEXT,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          agentKey TEXT NOT NULL,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL,
          output TEXT NOT NULL,
          reportPath TEXT,
          ticketId TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          filePath TEXT NOT NULL,
          content TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          agentKey TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL,
          summary TEXT NOT NULL,
          filePath TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          port INTEGER NOT NULL,
          url TEXT NOT NULL,
          username TEXT NOT NULL,
          password TEXT NOT NULL,
          status TEXT NOT NULL,
          command TEXT NOT NULL,
          logs TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      AGENT_KEYS.forEach((key, index) => {
        db.prepare(
          `INSERT OR IGNORE INTO agent_states
            (key, sortOrder, status, summary, updatedAt)
           VALUES (?, ?, 'Inicializado', '', ?)`,
        ).run(key, index, now);
      });
    } finally {
      db.close();
    }
  }

  private withDb<T>(project: ProjectRecord, callback: (db: DatabaseSync) => T): T {
    this.initProjectDatabase(project.sqlitePath);
    const db = new DatabaseSync(project.sqlitePath);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  private readIndex(): ProjectRecord[] {
    const raw = readFileSync(this.indexPath, 'utf8').trim();
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as ProjectRecord[];
  }

  private writeIndex(projects: ProjectRecord[]): void {
    writeFileSync(this.indexPath, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
  }

  private uniqueSlug(name: string): string {
    const base = this.slugify(name);
    const existing = new Set(this.readIndex().map((item) => item.slug));
    if (!existing.has(base)) {
      return base;
    }

    let counter = 2;
    while (existing.has(`${base}-${counter}`)) {
      counter += 1;
    }
    return `${base}-${counter}`;
  }

  private slugify(value: string): string {
    const slug = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return slug || `project-${Date.now()}`;
  }

  private serverFolderName(value: string): string {
    const normalized = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/gi, 'n')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized || `project_${Date.now()}`;
  }

  private createTimestampDirectory(root: string): string {
    this.ensureDirectory(root);
    let timestamp = Date.now();
    let timestampDir = join(root, String(timestamp));
    while (existsSync(timestampDir)) {
      timestamp += 1;
      timestampDir = join(root, String(timestamp));
    }
    this.ensureDirectory(timestampDir);
    return timestampDir;
  }

  private safeFileName(value: string): string {
    const normalized = value.replace(/[/\\?%*:|"<>]/g, '-').trim();
    return normalized || 'documento.txt';
  }

  private writePdfReport(filePath: string, title: string, content: string): void {
    const lines = this.renderPdfLines(title, content);
    const pages = this.paginatePdfLines(lines);
    const pageObjectIds = pages.map((_, index) => 3 + index * 2);
    const contentObjectIds = pages.map((_, index) => 4 + index * 2);
    const regularFontId = 3 + pages.length * 2;
    const boldFontId = regularFontId + 1;
    const monoFontId = boldFontId + 1;
    const objects: string[] = [];

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`;

    pages.forEach((pageLines, index) => {
      const pageId = pageObjectIds[index];
      const contentId = contentObjectIds[index];
      const stream = this.renderPdfPageStream(pageLines);
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R /F3 ${monoFontId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`;
      objects[contentId] = `<< /Length ${Buffer.byteLength(
        stream,
        'latin1',
      )} >>\nstream\n${stream}\nendstream`;
    });

    objects[regularFontId] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[boldFontId] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objects[monoFontId] =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let index = 1; index < objects.length; index += 1) {
      offsets[index] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let index = 1; index < objects.length; index += 1) {
      pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    writeFileSync(filePath, Buffer.from(pdf, 'latin1'));
  }

  private renderPdfLines(
    title: string,
    content: string,
  ): Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }> {
    const lines: Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }> = [];
    this.appendWrappedPdfLine(lines, this.pdfSafeText(title), 'title');
    lines.push({ text: '', style: 'body' });

    this.pdfSafeText(content)
      .split('\n')
      .forEach((rawLine) => {
        const trimmed = rawLine.trimEnd();
        if (!trimmed.trim()) {
          lines.push({ text: '', style: 'body' });
          return;
        }

        const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
        if (heading) {
          this.appendWrappedPdfLine(lines, heading[1], 'heading');
          return;
        }

        const isCode = trimmed.startsWith('    ') || trimmed.startsWith('```');
        this.appendWrappedPdfLine(lines, trimmed.replace(/^```[a-z]*$/i, ''), isCode ? 'code' : 'body');
      });

    return lines.length ? lines : [{ text: 'Sin contenido para reportar.', style: 'body' }];
  }

  private appendWrappedPdfLine(
    lines: Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }>,
    value: string,
    style: 'title' | 'heading' | 'body' | 'code',
  ): void {
    const maxLength = style === 'title' ? 58 : style === 'heading' ? 76 : 98;
    let remaining = value.trimEnd();
    if (!remaining) {
      lines.push({ text: '', style });
      return;
    }

    while (remaining.length > maxLength) {
      const slice = remaining.slice(0, maxLength);
      const cutAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('/'));
      const cut = cutAt > 35 ? cutAt : maxLength;
      lines.push({ text: remaining.slice(0, cut).trimEnd(), style });
      remaining = remaining.slice(cut).trimStart();
    }
    lines.push({ text: remaining, style });
  }

  private paginatePdfLines(
    lines: Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }>,
  ): Array<Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }>> {
    const pages: Array<Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }>> = [];
    let currentPage: Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }> = [];
    let y = 744;

    lines.forEach((line) => {
      const height = this.pdfLineHeight(line.style);
      if (y - height < 48 && currentPage.length) {
        pages.push(currentPage);
        currentPage = [];
        y = 744;
      }
      currentPage.push(line);
      y -= height;
    });

    if (currentPage.length) {
      pages.push(currentPage);
    }

    return pages.length ? pages : [[{ text: 'Sin contenido para reportar.', style: 'body' }]];
  }

  private renderPdfPageStream(
    lines: Array<{ text: string; style: 'title' | 'heading' | 'body' | 'code' }>,
  ): string {
    let y = 744;
    return lines
      .map((line) => {
        const font = line.style === 'code' ? '/F3' : line.style === 'body' ? '/F1' : '/F2';
        const size = line.style === 'title' ? 16 : line.style === 'heading' ? 12 : 10;
        const statement = `BT ${font} ${size} Tf 50 ${y} Td (${this.pdfEscape(
          line.text,
        )}) Tj ET`;
        y -= this.pdfLineHeight(line.style);
        return statement;
      })
      .join('\n');
  }

  private pdfLineHeight(style: 'title' | 'heading' | 'body' | 'code'): number {
    if (style === 'title') {
      return 24;
    }
    if (style === 'heading') {
      return 18;
    }
    return style === 'code' ? 13 : 14;
  }

  private pdfSafeText(value: string): string {
    return value
      .replace(/\r/g, '')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2022/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/[^\n\t\x20-\x7e\xa0-\xff]/g, '');
  }

  private pdfEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  private createId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  private ensureDirectory(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  private firstLine(value: string): string {
    return value.split('\n').find((line) => line.trim())?.trim().slice(0, 220) ?? '';
  }

  private renderInitialRules(project: ProjectRecord, businessRules: string): string {
    return `# Reglas de negocio - ${project.name}

## Contexto

Proyecto: ${project.name}

Tipo objetivo: ${project.targetType}

Ruta: ${project.projectPath}

## Reglas de negocio

${businessRules || '- Pendiente de levantar con el Agente 1.'}

## Memoria para prompts

Este archivo es la fuente de contexto del proyecto. Los agentes deben leerlo antes de proponer o ejecutar cambios.
`;
  }

  private renderTicket(
    project: ProjectRecord,
    ticket: DevelopmentTicket,
  ): string {
    return `# ${ticket.title}

ID: ${ticket.id}

Proyecto: ${project.name}

Estado: ${ticket.status}

Fecha: ${ticket.createdAt}

## Prompt del usuario

${ticket.prompt}

## Resumen del agente

${ticket.summary}
`;
  }
}
