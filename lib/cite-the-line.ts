/** Linhas adicionadas (`+`) por arquivo, na numeracao do arquivo NOVO. */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file = '';
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6).trim();
      if (!map.has(file)) map.set(file, new Set());
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw); // +c,d
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    // Header de arquivo/marcador so com ESPACO ("+++ b/path", "--- a/path"):
    // conteudo adicionado como "++count" nao tem espaco e deve contar como linha,
    // senao newLine para de avancar e desalinha todas as citacoes seguintes.
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+')) {
      map.get(file)?.add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // linha removida: nao avanca o contador do arquivo novo
    } else {
      newLine++; // contexto
    }
  }
  return map;
}

export interface Cite { file: string; start: number; end: number; }

export function parseCite(cite: string): Cite | null {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(cite.trim());
  if (!m) return null;
  // Sob noUncheckedIndexedAccess (tsconfig), os grupos do match sao string | undefined.
  // Guardamos o grupo 1 (arquivo) explicitamente; o regex casa => m[2] (start) sempre presente.
  const file = m[1];
  if (file === undefined) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { file, start, end };
}

/** A citacao e valida se cobre ao menos UMA linha adicionada do arquivo. */
export function isCiteValid(cite: string, added: Map<string, Set<number>>): boolean {
  const c = parseCite(cite);
  if (!c) return false;
  const lines = added.get(c.file);
  if (!lines) return false;
  for (let l = c.start; l <= c.end; l++) if (lines.has(l)) return true;
  return false;
}
