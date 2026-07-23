// Assert determinística do promptfoo: mede recall (casos positivos) e precisão (negativos)
// sobre o JSON de findings do agente. Match só por arquivo — a dimensão (agente) já é
// implícita pelo teste, e a severidade/categoria são texto livre do LLM, então NÃO entram
// no match (severidade fica como nota humana no expected.json). Negativos são avaliados
// pela ausência de findings com severidade bloqueante (P0/P1), alinhado à semântica real
// do gate: o gate só bloqueia merge em P0/P1, então P2 num caso negativo não é falso
// positivo do ponto de vista do gate. Retorna GradingResult { pass, score, reason }.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function matches(finding, want) {
  return want.file ? finding.file === want.file : true;
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

  // Caso negativo (anti falso-positivo): o agente nao pode levantar finding P0/P1
  // (severidades bloqueantes). P2 informativo e tolerado, pois o gate real so bloqueia P0/P1.
  if (!expected.positive) {
    const bloqueantes = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
    const pass = bloqueantes.length === 0;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass ? 'negativo: nenhum finding P0/P1 (ok)' : `negativo: ${bloqueantes.length} finding(s) P0/P1 indevido(s)`,
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
    reason: `recall ${matched.length}/${want.length} por arquivo (limiar ${threshold}); findings=${findings.length}`,
  };
}
