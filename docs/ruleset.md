# Ruleset (bloqueio de merge) — aplicar em cada repo pe-* coberto

Aplicar via GitHub API (org freeflowsoftware) em `main` e `develop`:

```json
{
  "name": "ai-review-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main", "refs/heads/develop"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": true,
        "allowed_merge_methods": ["squash", "merge"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "review-bot/verdict", "integration_id": <APP_ID> },
          { "context": "gates" },
          { "context": "ci/build" }
        ] } }
  ]
}
```

- O `integration_id` trava a origem do check ao App movvia-ai-review (ninguem forja).
- Bypass list: so o App quando autor; nunca humanos.
