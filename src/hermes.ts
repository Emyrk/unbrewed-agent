export interface HermesClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export class HermesClient {
  constructor(private readonly options: HermesClientOptions) {}

  async complete(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Hermes API ${response.status}: ${text.slice(0, 500)}`);
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('Hermes API response had no message content');
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}
