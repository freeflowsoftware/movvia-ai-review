# ADR-002 — Dispensa manual de finding por comando e dispensa de P0 por CODEOWNER

- **Status:** Proposta (vira Aceita só com confirmação humana do Pablo)
- **Data:** 2026-07-22
- **Autor:** Antonio Tolio (via brainstorm superpowers)
- **Relacionado:** PED-2728, `docs/ADR-001-ai-review-inhouse.md`,
  `docs/auditoria-review-ia/18-descartar-finding-via-comando.md`
- **Supersedes:** —

## Contexto

O check run `review-bot/verdict` trava o merge quando sobra qualquer P0/P1 vivo
(`lib/gatekeeper.ts:307` — `decideVerdict`). Quando o finding bloqueante é falso-positivo,
não há via manual determinística de desbloqueio: só correção de código, convencer o judge
(LLM) com evidência verificável, ou editar à mão o JSON do store de withdrawals.

O PED-2728 introduz o comando `/ai-review dismiss <findingId> <motivo>`, que grava
determinísticamente no store e destrava o merge via o recompute já existente
(`post.ts:316-342`). A questão de política que exige ADR é: **P0 pode ser dispensado por
comando?**

Hoje P0 é inviolável por decisão prévia (Pablo): `upsertWithdrawal` rejeita P0
(`withdrawals.ts:57-58`) e `decideJudge` retorna sempre `reply_only` para P0
(`judge.ts:44-48`). P0 cobre credencial hardcoded, operação financeira sem lock, SQLi,
quebra de isolamento multi-tenant (BOLA/IDOR) — falhas em gate fintech. Relaxar isso é
mudança de política de merge, não detalhe de implementação.

## Decisão

1. **Comando de dispensa manual (P1/P2)** — permitido para autor com
   `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` (mesmo fork guard do `/ai-review`),
   com **motivo obrigatório**, gravação determinística no store (sem LLM), auditoria
   (quem/quando/motivo) e reversão por `/ai-review undismiss`.

2. **Dispensa de P0** — permitida **apenas por CODEOWNER** do arquivo do finding, e apenas
   quando a flag `dismiss.allow_p0_by_codeowner` (em `config/defaults.yml`) estiver `true`.
   O **default é `false`**: enquanto este ADR estiver em *Proposta*, P0 permanece
   inviolável na prática. A flag só vai a `true` quando este ADR for *Aceito*.

3. **Defesa em profundidade** — `upsertWithdrawal` (caminho do judge) **continua
   rejeitando P0 incondicionalmente**. A via P0 do comando usa uma função separada,
   `upsertDismissal(list, entry, allowP0)`, para que um erro no judge nunca introduza P0
   e a única porta de P0 seja o comando explícito de CODEOWNER.

4. **Fail-closed no CODEOWNER** — se não for possível confirmar que o autor é CODEOWNER do
   arquivo (CODEOWNERS ilegível, membership de time indeterminada, erro de rede), trata-se
   como **não-CODEOWNER** e o P0 permanece bloqueado.

5. **Trilha de auditoria reforçada para P0** — além do registro no store, o dismiss de P0
   abre a issue de feedback e registra reply explícito na thread nomeando o CODEOWNER
   autor e o motivo.

## Consequências

**Positivas**
- Falso-positivo P0/P1 deixa de travar o time indefinidamente; há via autorizada e auditável.
- P0 mantém proteção forte: default bloqueado, só CODEOWNER, defesa em profundidade,
  fail-closed. O relaxe é opt-in explícito e reversível (flag + ADR).
- Cada dismiss vira input de calibração (issue de feedback), reduzindo reincidência.

**Negativas / riscos**
- Um CODEOWNER pode dispensar um P0 real. Mitigação: motivo obrigatório, auditoria,
  expiração automática do withdrawal quando o arquivo muda (`computeValidWithdrawals`),
  e a issue de feedback registra a decisão publicamente.
- Re-run do pipeline por dismiss custa LLM e pode surfar findings novos. Aceito no v1;
  otimização registrada no plano.

## Alternativas consideradas

- **(a) P0 inviolável (comando só P1/P2).** Mais seguro e sem ADR, mas não atende o caso
  de falso-positivo P0 que motivou o pedido. **Rejeitada** no brainstorm de 2026-07-22 em
  favor de (b) com salvaguardas.
- **Recompute sem re-rodar agentes** (reconstruir findings das threads/summary). Mais
  barato, porém arriscado num gate fintech (subcontagem → success indevido). Adiada.

## Reversão

Como este ADR é imutável após Aceito, mudar de rumo cria um novo ADR com `supersedes:
ADR-002`. Enquanto Proposta, basta manter a flag `false` (P0 segue inviolável).
