---
title: "AI Code Review in-house (movvia-ai-review) substitui CodeRabbit"
category: adr
status: draft
product: pe
owner: pablowinck
created: 2026-06-02
updated: 2026-06-02
confidence: medium
---

# ADR-001: Code review por IA in-house em vez de SaaS

## Contexto
CodeRabbit (SaaS) cobra por seat, é caixa-preta e não faz gating de domínio (Jira/ADR/.claude/rules).

## Decisão
Construir `movvia-ai-review`: reusable workflow + N agentes paralelos (opencode, multi-modelo barato) + gatekeeper anti-alucinacao/adversarial + gates Jira/ADR + bloqueio via GitHub App check run.

## Alternativas consideradas
- **CodeRabbit Enterprise self-host:** caro (≥500 seats), sem gating de dominio proprio.
- **Qodo PR-Agent puro:** bom blueprint (Apache-2.0), mas opinativo; reusamos schema/self-reflection, nao a orquestracao.
- **Claude Code Action:** reviewer mais forte, mas exige proxy LiteLLM para modelos baratos (atrito de custo).

## Por que não comprar
O diferencial defensável é o gating de domínio + custo controlado com modelos baratos + contribuição aberta do time. Nenhum vendor faz isso.

## Consequências
Manutencao de um repo central; risco de falso-positivo mitigado por cite-the-line + adversarial + calibracao amostral Sonnet.
