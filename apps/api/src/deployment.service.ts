import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ProjectRecord, ProjectTarget } from './orchestrator.types';
import { ProjectStoreService } from './project-store.service';

interface DeploymentAttempt {
  port: number;
  url: string;
  username: string;
  password: string;
  status: string;
  command: string;
  logs: string;
  started: boolean;
}

@Injectable()
export class DeploymentService {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams[]>();
  private readonly processLogs = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly store: ProjectStoreService,
  ) {}

  async deploy(
    project: ProjectRecord,
    targetType: ProjectTarget,
  ): Promise<DeploymentAttempt> {
    const username =
      this.configService.get<string>('ORCHESTRATOR_DEFAULT_USER') || 'admin';
    const password =
      this.configService.get<string>('ORCHESTRATOR_DEFAULT_PASSWORD') ||
      'Admin123!';
    let port = 0;
    try {
      port = await this.findAvailablePort(4100);
      const agentDir = this.store.ensureAgentDirectory(project.projectPath);
      writeFileSync(
        join(agentDir, 'deployment.env'),
        `PORT=${port}
DEFAULT_ADMIN_USER=${username}
DEFAULT_ADMIN_PASSWORD=${password}
`,
        'utf8',
      );

      if (this.processes.has(project.id)) {
        this.stopProjectProcesses(project.id);
      }
      this.processLogs.delete(project.id);

      if (targetType === 'executable' || existsSync(join(project.projectPath, 'pom.xml'))) {
        return this.deployJava(project, port, username, password);
      }

      if (existsSync(join(project.projectPath, 'package.json'))) {
        return this.deployNode(project, port, username, password);
      }

      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'requiere-aclaracion',
        command: '',
        logs:
          'No se detecto package.json ni pom.xml. Indica el comando de levantamiento del proyecto.',
        started: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        port,
        url: port ? `http://localhost:${port}` : 'pendiente',
        username,
        password,
        status: 'fallo-despliegue',
        command: '',
        logs: `El despliegue fallo antes de levantar el proceso.\n${message}`,
        started: false,
      };
    }
  }

  private async deployNode(
    project: ProjectRecord,
    port: number,
    username: string,
    password: string,
  ): Promise<DeploymentAttempt> {
    const packageJson = JSON.parse(
      readFileSync(join(project.projectPath, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const script = packageJson.scripts?.dev
      ? 'dev'
      : packageJson.scripts?.start
        ? 'start'
        : undefined;

    if (!script) {
      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'requiere-aclaracion',
        command: 'npm run dev',
        logs: 'El package.json no tiene scripts dev/start.',
        started: false,
      };
    }

    let logs = '';
    if (!existsSync(join(project.projectPath, 'node_modules'))) {
      const install = await this.runCommand(
        this.bin('npm'),
        ['install'],
        project.projectPath,
        { PORT: String(port), DEFAULT_ADMIN_USER: username, DEFAULT_ADMIN_PASSWORD: password },
      );
      logs += install.logs;
      if (install.exitCode !== 0) {
        return {
          port,
          url: `http://localhost:${port}`,
          username,
          password,
          status: 'fallo-instalacion',
          command: 'npm install',
          logs,
          started: false,
        };
      }
    }

    if (this.isWebWorkspace(project.projectPath)) {
      return this.deployWebWorkspace(project, port, username, password, logs);
    }

    const args = ['run', script];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.bin('npm'), args, project.projectPath, {
        PORT: String(port),
        DEFAULT_ADMIN_USER: username,
        DEFAULT_ADMIN_PASSWORD: password,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'fallo-arranque',
        command: `npm run ${script}`,
        logs: `${logs}\nNo se pudo iniciar el proceso Node.\nCWD: ${project.projectPath}\nError: ${message}`,
        started: false,
      };
    }
    this.captureManagedProcess(project.id, child, 'node');

    return {
      port,
      url: `http://localhost:${port}`,
      username,
      password,
      status: 'levantado',
      command: `npm run ${script}`,
      logs: `${logs}\nProceso iniciado con PID ${child.pid ?? 'desconocido'}.`,
      started: true,
    };
  }

  private async deployJava(
    project: ProjectRecord,
    port: number,
    username: string,
    password: string,
  ): Promise<DeploymentAttempt> {
    const packageResult = await this.runCommand(
      this.bin('mvn'),
      ['-DskipTests', 'package'],
      project.projectPath,
      { PORT: String(port), DEFAULT_ADMIN_USER: username, DEFAULT_ADMIN_PASSWORD: password },
    );

    if (packageResult.exitCode !== 0) {
      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'fallo-build',
        command: 'mvn -DskipTests package',
        logs: packageResult.logs,
        started: false,
      };
    }

    const jar = this.findJar(join(project.projectPath, 'target'));
    if (!jar) {
      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'requiere-aclaracion',
        command: 'java -jar target/app.jar',
        logs: `${packageResult.logs}\nNo se encontro un jar en target/.`,
        started: false,
      };
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess('java', ['-jar', jar], project.projectPath, {
        PORT: String(port),
        DEFAULT_ADMIN_USER: username,
        DEFAULT_ADMIN_PASSWORD: password,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        port,
        url: `http://localhost:${port}`,
        username,
        password,
        status: 'fallo-arranque',
        command: `java -jar ${jar}`,
        logs: `${packageResult.logs}\nNo se pudo iniciar el proceso Java.\nCWD: ${project.projectPath}\nError: ${message}`,
        started: false,
      };
    }
    this.captureManagedProcess(project.id, child, 'java');

    return {
      port,
      url: `http://localhost:${port}`,
      username,
      password,
      status: 'levantado',
      command: `java -jar ${jar}`,
      logs: `${packageResult.logs}\nProceso iniciado con PID ${child.pid ?? 'desconocido'}.`,
      started: true,
    };
  }

  private async deployWebWorkspace(
    project: ProjectRecord,
    apiPort: number,
    username: string,
    password: string,
    previousLogs: string,
  ): Promise<DeploymentAttempt> {
    const webPort = await this.findAvailablePort(apiPort + 1);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const webUrl = `http://localhost:${webPort}`;
    this.ensureViteProxyUsesEnv(project.projectPath);

    let apiProcess: ChildProcessWithoutNullStreams;
    let webProcess: ChildProcessWithoutNullStreams;
    try {
      apiProcess = this.spawnProcess(
        this.bin('npm'),
        ['run', 'start:dev', '-w', 'apps/api'],
        project.projectPath,
        {
          PORT: String(apiPort),
          DEFAULT_ADMIN_USER: username,
          DEFAULT_ADMIN_PASSWORD: password,
        },
      );
      webProcess = this.spawnProcess(
        this.bin('npm'),
        [
          'run',
          'dev',
          '-w',
          'apps/web',
          '--',
          '--host',
          '127.0.0.1',
          '--port',
          String(webPort),
        ],
        project.projectPath,
        {
          PORT: String(webPort),
          VITE_API_TARGET: apiUrl,
          VITE_API_URL: `${apiUrl}/api`,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        port: webPort,
        url: webUrl,
        username,
        password,
        status: 'fallo-arranque',
        command: 'npm run start:dev -w apps/api && npm run dev -w apps/web',
        logs: `${previousLogs}\nNo se pudo iniciar el workspace web.\nAPI port: ${apiPort}\nWEB port: ${webPort}\nCWD: ${project.projectPath}\nError: ${message}`,
        started: false,
      };
    }

    this.captureManagedProcess(project.id, apiProcess, 'api');
    this.captureManagedProcess(project.id, webProcess, 'web');

    const [apiReady, webReady] = await Promise.all([
      this.waitForAnyHttp([`${apiUrl}/api/health`, apiUrl], 90000),
      this.waitForHttp(webUrl, 90000),
    ]);
    if (!apiReady || !webReady) {
      this.stopProjectProcesses(project.id);
      await this.sleep(500);
    }
    const processLogs = this.getProcessLogs(project.id);
    const logs = `${previousLogs}
API iniciado con PID ${apiProcess.pid ?? 'desconocido'} en ${apiUrl}.
Web iniciado con PID ${webProcess.pid ?? 'desconocido'} en ${webUrl}.
Verificacion API: ${apiReady ? 'ok' : 'sin respuesta'}.
Verificacion Web: ${webReady ? 'ok' : 'sin respuesta'}.

## Logs de procesos

${processLogs || 'Sin logs capturados.'}`;

    if (!apiReady || !webReady) {
      return {
        port: webPort,
        url: webUrl,
        username,
        password,
        status: !apiReady ? 'fallo-verificacion-api' : 'fallo-verificacion-web',
        command: `npm run start:dev -w apps/api; npm run dev -w apps/web -- --host 127.0.0.1 --port ${webPort}`,
        logs,
        started: false,
      };
    }

    return {
      port: webPort,
      url: webUrl,
      username,
      password,
      status: 'levantado',
      command: `API: npm run start:dev -w apps/api | Web: npm run dev -w apps/web -- --host 127.0.0.1 --port ${webPort}`,
      logs,
      started: true,
    };
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number; logs: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(command, args, cwd, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          exitCode: 1,
          logs: `No se pudo ejecutar el comando.\nComando: ${this.formatCommand(command, args)}\nCWD: ${cwd}\nError: ${message}`,
        });
        return;
      }
      let logs = '';
      const append = (chunk: Buffer) => {
        logs = `${logs}${chunk.toString()}`.slice(-20000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timeout = setTimeout(() => {
        logs += '\nTiempo maximo de comando alcanzado.';
        child.kill();
        resolve({ exitCode: 124, logs });
      }, 120000);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ exitCode: code ?? 1, logs });
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ exitCode: 1, logs: `${logs}\n${error.message}` });
      });
    });
  }

  private captureManagedProcess(
    projectId: string,
    child: ChildProcessWithoutNullStreams,
    label: string,
  ): void {
    child.stdout.on('data', (chunk: Buffer) => {
      this.appendProcessLog(projectId, label, chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.appendProcessLog(projectId, label, chunk.toString());
    });
    const removeProcess = () => {
      const remaining = (this.processes.get(projectId) ?? []).filter(
        (process) => process !== child,
      );
      if (remaining.length) {
        this.processes.set(projectId, remaining);
        return;
      }
      this.processes.delete(projectId);
    };
    child.on('error', (error) => {
      this.appendProcessLog(projectId, label, `Error del proceso: ${error.message}`);
      removeProcess();
    });
    child.on('close', (code) => {
      this.appendProcessLog(
        projectId,
        label,
        `Proceso finalizado con codigo ${code ?? 'desconocido'}`,
      );
      removeProcess();
    });
    const current = this.processes.get(projectId) ?? [];
    this.processes.set(projectId, [...current, child]);
  }

  private appendProcessLog(projectId: string, label: string, message: string): void {
    const lines = message
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `[${label}] ${line}`)
      .join('\n');
    if (!lines) {
      return;
    }

    const current = this.processLogs.get(projectId) ?? '';
    this.processLogs.set(projectId, `${current}${lines}\n`.slice(-30000));
  }

  private getProcessLogs(projectId: string): string {
    return this.processLogs.get(projectId)?.trim() ?? '';
  }

  private stopProjectProcesses(projectId: string): void {
    const current = this.processes.get(projectId) ?? [];
    current.forEach((child) => {
      if (!child.killed) {
        this.stopChildProcess(child);
      }
    });
    this.processes.delete(projectId);
  }

  private stopChildProcess(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) {
      child.kill();
      return;
    }

    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      killer.on('error', () => child.kill());
      return;
    }

    child.kill();
  }

  private isWebWorkspace(projectPath: string): boolean {
    return (
      existsSync(join(projectPath, 'apps', 'api', 'package.json')) &&
      existsSync(join(projectPath, 'apps', 'web', 'package.json'))
    );
  }

  private ensureViteProxyUsesEnv(projectPath: string): void {
    const viteConfigPath = join(projectPath, 'apps', 'web', 'vite.config.ts');
    if (!existsSync(viteConfigPath)) {
      return;
    }

    const current = readFileSync(viteConfigPath, 'utf8');
    if (current.includes('VITE_API_TARGET')) {
      return;
    }
    if (!current.includes("'http://127.0.0.1:3000'")) {
      return;
    }

    writeFileSync(
      viteConfigPath,
      current.replace(
        "'/api': 'http://127.0.0.1:3000'",
        "'/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000'",
      ),
      'utf8',
    );
  }

  private async waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2500),
        });
        if (response.status < 500) {
          return true;
        }
      } catch {
        // Keep polling until the process has finished booting or the timeout ends.
      }
      await this.sleep(1000);
    }
    return false;
  }

  private async waitForAnyHttp(urls: string[], timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (const url of urls) {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(2500),
          });
          if (response.status < 500) {
            return true;
          }
        } catch {
          // Try the next URL before waiting for the next polling cycle.
        }
      }
      await this.sleep(1000);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private spawnProcess(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): ChildProcessWithoutNullStreams {
    if (!existsSync(cwd)) {
      throw new Error(`La carpeta de trabajo no existe: ${cwd}`);
    }

    return spawn(command, args, {
      cwd,
      env: this.buildEnv(env),
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  }

  private buildEnv(env: Record<string, string>): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        merged[key] = value;
      }
    }
    for (const [key, value] of Object.entries(env)) {
      merged[key] = String(value);
    }
    return merged;
  }

  private formatCommand(command: string, args: string[]): string {
    return [command, ...args].join(' ');
  }

  private findJar(targetDir: string): string | undefined {
    if (!existsSync(targetDir)) {
      return undefined;
    }

    const entries = readdirSync(targetDir, { withFileTypes: true });
    const jar = entries.find(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.jar') &&
        !entry.name.endsWith('-sources.jar') &&
        !entry.name.endsWith('-javadoc.jar'),
    );
    return jar ? join(targetDir, jar.name) : undefined;
  }

  private async findAvailablePort(start: number): Promise<number> {
    for (let port = start; port < start + 200; port += 1) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const address = server.address();
        server.close();
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error('No se pudo reservar un puerto.'));
      });
      server.on('error', reject);
    });
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()
        .once('error', () => resolve(false))
        .once('listening', () => {
          server.close();
          resolve(true);
        })
        .listen(port);
    });
  }

  private bin(command: 'npm' | 'mvn'): string {
    return process.platform === 'win32' ? `${command}.cmd` : command;
  }
}
