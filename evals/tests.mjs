// Gerador de casos de teste do promptfoo: varre tests/fixtures/eval/<caso>/ (ignorando dirs
// com prefixo _) e monta um teste por fixture. Adicionar um caso = criar uma pasta com
// diff.patch + expected.json — sem editar este arquivo. A rubrica llm-rubric usa o grader
// global (defaultTest.options.provider no promptfooconfig.yaml).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = join(ROOT, 'tests', 'fixtures', 'eval');

export default function generateTests() {
  return readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const rel = `tests/fixtures/eval/${d.name}`;
      const expected = JSON.parse(readFileSync(join(EVAL_DIR, d.name, 'expected.json'), 'utf8'));

      const assert = [
        { type: 'is-json' },
        { type: 'javascript', value: 'file://evals/assert-recall.mjs' },
      ];
      // Rubrica de qualidade só faz sentido quando há findings esperados.
      if (expected.positive) {
        assert.push({
          type: 'llm-rubric',
          value:
            'Cada item de "findings" traz um rationale que explica um problema tecnico real presente no diff, e um campo "cite" no formato arquivo:linha coerente com as linhas adicionadas. Responda PASS se os findings fazem sentido tecnico e FAIL se sao vagos, inventados ou nao correspondem ao diff.',
        });
      }

      return {
        description: `${expected.agent}: ${d.name}`,
        vars: {
          agent: expected.agent,
          diffPath: `${rel}/diff.patch`,
          expectedPath: `${rel}/expected.json`,
          repoDir: 'tests/fixtures/eval/_repo',
        },
        assert,
      };
    });
}
