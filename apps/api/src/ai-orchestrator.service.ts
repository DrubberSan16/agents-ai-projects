import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GenerateOptions {
  system: string;
  prompt: string;
  fallback: () => string;
}

@Injectable()
export class AiOrchestratorService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim() ?? '';
    this.model =
      this.configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4.1-mini';
    this.requestTimeoutMs = Number(
      this.configService.get<string>('OPENAI_REQUEST_TIMEOUT_MS') ?? 12000,
    );
  }

  async generate(options: GenerateOptions): Promise<{
    text: string;
    source: 'openai' | 'local';
  }> {
    if (!this.apiKey) {
      return {
        text: `${options.fallback()}\n\n> Modo local: configura OPENAI_API_KEY en apps/api/.env para activar respuestas de OpenAI.`,
        source: 'local',
      };
    }

    try {
      const [{ createOpenAI }, { generateText }] = await Promise.all([
        import('@ai-sdk/openai'),
        import('ai'),
      ]);
      const provider = createOpenAI({ apiKey: this.apiKey });
      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        this.requestTimeoutMs,
      );
      const result = await generateText({
        model: provider.responses(this.model as never),
        system: options.system,
        prompt: options.prompt,
        temperature: 0.2,
        abortSignal: abortController.signal,
      }).finally(() => clearTimeout(timeout));

      return {
        text: result.text.trim(),
        source: 'openai',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: `${options.fallback()}\n\n> Modo local por error de OpenAI: ${message}`,
        source: 'local',
      };
    }
  }
}
