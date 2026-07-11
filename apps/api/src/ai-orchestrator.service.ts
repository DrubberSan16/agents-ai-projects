import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GenerateOptions {
  system: string;
  prompt: string;
  fallback: () => string;
  timeoutMs?: number;
  images?: Array<{
    name: string;
    mimeType: string;
    dataUrl: string;
  }>;
}

@Injectable()
export class AiOrchestratorService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly fallbackOnError: boolean;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim() ?? '';
    this.model =
      this.configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4.1-mini';
    this.requestTimeoutMs = Number(
      this.configService.get<string>('OPENAI_REQUEST_TIMEOUT_MS') ?? 180000,
    );
    this.fallbackOnError =
      this.configService.get<string>('OPENAI_FALLBACK_ON_ERROR') === 'true';
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
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => abortController.abort(), timeoutMs)
          : undefined;
      const result = await generateText({
        model: provider.responses(this.model as never),
        system: options.system,
        ...(options.images?.length
          ? {
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: options.prompt },
                    ...options.images.map((image) => ({
                      type: 'image',
                      image: this.imageDataUrlToBuffer(image.dataUrl),
                      mediaType: image.mimeType,
                    })),
                  ],
                },
              ],
            }
          : { prompt: options.prompt }),
        temperature: 0.2,
        abortSignal: abortController.signal,
      } as never).finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
      });

      return {
        text: result.text.trim(),
        source: 'openai',
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const message = this.humanizeOpenAiError(rawMessage, timeoutMs);
      const shouldFallback = this.fallbackOnError || this.isQuotaError(rawMessage);
      if (!shouldFallback) {
        throw new ServiceUnavailableException(message);
      }
      return {
        text: `${options.fallback()}\n\n> Modo local por error de OpenAI: ${message}`,
        source: 'local',
      };
    }
  }

  private humanizeOpenAiError(rawMessage: string, timeoutMs: number): string {
    if (rawMessage === 'This operation was aborted') {
      return `OpenAI no respondio antes de ${timeoutMs} ms. Sube el timeout del agente o reduce el tamano de la solicitud.`;
    }

    if (this.isQuotaError(rawMessage)) {
      return 'La cuenta o proyecto de OpenAI excedio la cuota disponible. Revisa plan, billing, limites del proyecto o agrega credito. Mientras tanto se genero una respuesta local con el scaffold disponible.';
    }

    return rawMessage;
  }

  private isQuotaError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('exceeded your current quota') ||
      normalized.includes('insufficient_quota') ||
      normalized.includes('billing details') ||
      normalized.includes('check your plan')
    );
  }

  private imageDataUrlToBuffer(dataUrl: string): Buffer {
    const base64 = dataUrl.includes(',') ? dataUrl.split(',').at(-1) ?? '' : dataUrl;
    return Buffer.from(base64, 'base64');
  }
}
