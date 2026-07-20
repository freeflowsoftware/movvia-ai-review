// Assert determinística do promptfoo: mede recall (casos positivos) e precisão (negativos)
// sobre o JSON de findings do agente. Match por arquivo + severidade (quando declarada);
// a categoria é texto livre do LLM, então NÃO é usada no match (fica como nota humana no
// expected.json). Retorna GradingResult { pass, score, reason }.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function matches(finding, want) {
  if (want.file && finding.file !== want.file) return false;
  if (want.severity && finding.severity !== want.severity) return false;
  return true;
}

export default function assertRecall(output, context) {
  const vars = (context && context.vars) || {};
  const expected = JSON.parse(readFileSync(join(ROOT, vars.expectedPath), 'utf8'));

  let findings;
  try {
    findings = JSON.parse(output).findings || [];
  } catch {
    return { pass: false, score: 0, reason: 'saida do agente nao e JSON valido' };
  }

  // Caso negativo (anti falso-positivo): o agente NAO pode reportar nada.
  if (!expected.positive) {
    const pass = findings.length === 0;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass ? 'negativo: nenhum finding (ok)' : `negativo: esperava [], veio ${findings.length} finding(s)`,
    };
  }

  // Caso positivo: todo finding esperado deve aparecer (recall).
  const want = expected.expected || [];
  const matched = want.filter((w) => findings.some((f) => matches(f, w)));
  const recall = want.length ? matched.length / want.length : 1;
  const threshold = expected.threshold ?? 1;
  const pass = recall >= threshold;
  return {
    pass,
    score: recall,
    reason: `recall ${matched.length}/${want.length} (limiar ${threshold}); findings=${findings.length}`,
  };
}
