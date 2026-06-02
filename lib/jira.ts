const JIRA_KEY = /\b(PED|PEG|AR|AN)-\d+\b/;

export function extractJiraKey(text: string): string | null {
  return JIRA_KEY.exec(text)?.[0] ?? null;
}

/** Borda externa (DIP): implementacao real chama a Jira REST API; testes usam fake. */
export interface JiraClient {
  issueExists(key: string): Promise<boolean>;
}

export async function validateJiraKey(key: string, client: JiraClient): Promise<boolean> {
  return client.issueExists(key);
}

/** Implementacao HTTP real (Jira Cloud REST v3). Usada no CI; nao coberta por unit test. */
export class HttpJiraClient implements JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string,
  ) {}
  async issueExists(key: string): Promise<boolean> {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}?fields=key`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    return res.status === 200;
  }
}

// CLI: `tsx lib/jira.ts "<titulo do PR>"` → exit 0 se valido, 1 se ausente/invalido.
if (process.argv[1]?.endsWith('jira.ts')) {
  const title = process.argv[2] ?? '';
  const key = extractJiraKey(title);
  if (!key) {
    console.error('::error::PR sem chave Jira no titulo (esperado PED-1234, PEG-xx, AR-xx, AN-xx).');
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
