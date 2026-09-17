# InsightsEasy

## Five-core development branch

The initial implementation is scoped to exactly five customer workflows from the supplied Unified Marketing Platform Technical Master v4:

1. Connections and durable intake — source bindings, raw-byte authentication, receipts and transactional outbox.
2. First-party acquisition journeys — permitted observed touches, acquisition evidence and explicit source/visitor linkage.
3. Leads and CRM delivery — canonical leads, lifecycle history, durable commands and ambiguous-outcome reconciliation.
4. Revenue, attribution and reporting — exact sale/refund accounting, three rule-based models, frozen snapshots and CSV.
5. Consent-controlled conversion feedback — eligibility preview, current-purpose checks, durable delivery and corrections.

Tenant authentication, policy, audit, MongoDB, Kafka, RabbitMQ, BullMQ, separate queue/cache Redis, Docker, Kubernetes and CI/CD support these workflows; they are not additional product modules.

## Current publication status

This GitHub branch is an incomplete bootstrap, not the complete runnable application. Some application-source writes were blocked by the connected write tool. The complete source package and a Git patch are provided in the originating development conversation so they can be applied to this branch without force-pushing or modifying main.

The complete local package passed server/frontend TypeScript checks, the Next.js production build, ESLint and 39 unit/contract tests. One test also checks 1,000 deterministic credit-conservation cases. These are local-package results, not end-to-end results for the files currently committed here.

The audited dependency artifact was produced by GitHub Actions run 35255885461. Its one-time resolution workflow has been retired. The full application's repeatable CI and deployment workflows are in the source handoff, not yet operational on this partial branch.

Real MongoDB/broker integration tests, browser workflows, image builds, Kubernetes deployment and live-provider certification remain unverified. CRM and advertising destinations in the initial package are explicitly labeled simulators. No Meta, Google or Zoho production integration is claimed.

Keep the pull request in draft until source publication, clean-checkout CI and required integration tests pass. Do not deploy this partial repository as production software.
