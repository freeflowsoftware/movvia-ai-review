const JIRA_KEY = /\b(PED|PEG|AR|AN|SEO)-\d+\b/;

export function extractJiraKey(text: string): string | null {
  return JIRA_KEY.exec(text)?.[0] ?? null;
}

/** US do Jira (titulo + descricao) que o agente de requisitos confronta com o diff. */
export interface JiraTicket {
  summary: string;
  description: string;
}

/** Borda externa (DIP): implementacao real chama a Jira REST API; testes usam fake. */
export interface JiraClient {
  issueExists(key: string): Promise<boolean>;
  /** Contexto da US (summary/description) ou null se a issue nao existe. */
  getIssueContext(key: string): Promise<JiraTicket | null>;
}

export async function validateJiraKey(key: string, client: JiraClient): Promise<boolean> {
  return client.issueExists(key);
}

export async function fetchJiraTicket(key: string, client: JiraClient): Promise<JiraTicket | null> {
  return client.getIssueContext(key);
}

/** Implementacao HTTP real (Jira Cloud REST v3). Usada no CI; nao coberta por unit test. */
export class HttpJiraClient implements JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string,
  ) {}
  async issueExists(key: string): Promise<boolean> {
    const res = await this.getIssue(key, 'key');
    return res.status === 200;
  }
  async getIssueContext(key: string): Promise<JiraTicket | null> {
    const res = await this.getIssue(key, 'summary,description');
    if (res.status !== 200) return null;
    const body = (await res.json()) as { fields?: { summary?: string; description?: unknown } };
    return {
      summary: body.fields?.summary ?? '',
      description: adfToText(body.fields?.description),
    };
  }
  private getIssue(key: string, fields: string): Promise<Response> {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    return fetch(`${this.baseUrl}/rest/api/3/issue/${key}?fields=${fields}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
  }
}

/**
 * Achata a descricao da Jira para texto puro. A REST v3 devolve description em ADF
 * (Atlassian Document Format: arvore de nodes com `text`/`content`), mas instancias
 * antigas ainda mandam string. Tratamos ambos para o agente ler os criterios de aceite.
 */
function adfToText(description: unknown): string {
  if (typeof description === 'string') return description;
  if (typeof description !== 'object' || description === null) return '';
  const node = description as { text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.map(adfToText).join(' ').trim();
}

// CLI: `tsx lib/jira.ts "<titulo do PR>"` → exit 0 se valido, 1 se ausente/invalido.
if (process.argv[1]?.endsWith('jira.ts')) {
  const title = process.argv[2] ?? '';
  const key = extractJiraKey(title);
  if (!key) {
    console.error('::error::PR sem chave Jira no titulo (esperado PED-1234, PEG-xx, AR-xx, AN-xx, SEO-xx).');
    process.exit(1);
  }
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
    const ok = await validateJiraKey(key, new HttpJiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN));
    if (!ok) {
      console.error(`::error::Chave Jira ${key} nao encontrada no projeto.`);
      process.exit(1);
    }
  }
  console.log(`Jira OK: ${key}`);
}
