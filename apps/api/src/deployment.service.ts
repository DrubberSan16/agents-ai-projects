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
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly configService: ConfigService,
    private readonly store: ProjectStoreService,
  ) {}

  async deploy(
    project: ProjectRecord,
    targetType: ProjectTarget,
  ): Promise<DeploymentAttempt> {
    const port = await this.findAvailablePort(4100);
    const username =
      this.configService.get<string>('ORCHESTRATOR_DEFAULT_USER') || 'admin';
    const password =
      this.configService.get<string>('ORCHESTRATOR_DEFAULT_PASSWORD') ||
      'Admin123!';
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
      const current = this.processes.get(project.id);
      current?.kill();
      this.processes.delete(project.id);
    }

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

    const args = ['run', script];
    const child = spawn(this.bin('npm'), args, {
      cwd: project.projectPath,
      env: {
        ...process.env,
        PORT: String(port),
        DEFAULT_ADMIN_USER: username,
        DEFAULT_ADMIN_PASSWORD: password,
      },
    });
    this.captureManagedProcess(project.id, child);

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

    const child = spawn('java', ['-jar', jar], {
      cwd: project.projectPath,
      env: {
        ...process.env,
        PORT: String(port),
        DEFAULT_ADMIN_USER: username,
        DEFAULT_ADMIN_PASSWORD: password,
      },
    });
    this.captureManagedProcess(project.id, child);

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

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number; logs: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
      });
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
  ): void {
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);
    child.on('close', () => this.processes.delete(projectId));
    this.processes.set(projectId, child);
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
