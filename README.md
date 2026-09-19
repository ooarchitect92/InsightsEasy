# InsightsEasy — five workflow microservices

## Scope

Exactly five business services: **connections**, **journeys**, **crm**, **reporting**, and **activation**. Identity, the gateway, worker processes, sandbox provider simulators, Kafka, RabbitMQ, BullMQ, separate queue/cache Redis, Docker, Kubernetes and CI/CD are supporting foundations, not additional product features.

The local source revision separates owner databases and credentials, signed service-to-service HTTP, signed committed events, current actor/workspace authorization, action/task recovery, and independent API/worker deployments. The frontend retains the same five workflows.

## Important: this branch is not yet a runnable checkout

The connected GitHub tool accepted the service ownership registry, connections handler, scoped store, service authentication/RPC and domain/input contracts. It blocked the remaining grouped runtime upload and a corrective source write. The complete local microservice source package and checked patch are supplied in the originating development conversation. They have not all been committed here.

The published connections handler also requires the patch's transaction correction: its `setEnabled` version read must use the active `tx`, not the outer `store`. The corrected local implementation is included in the source handoff. Do not merge or deploy the partial branch, and do not treat local test results as certification of these incomplete published files.

## Observed local verification

The microservice source passed backend/frontend TypeScript checks, ESLint, the production frontend build, 39 existing pure unit/contract checks and 44 new service/security/recovery checks. The new suite exercises actual signed HTTP calls and an HTTP simulator, but uses isolated test-only memory stores and callback dispatchers. These are not real MongoDB or broker integration results.

Two browser tests were attempted but navigation was blocked by the test environment's Chromium administrator policy. Docker was unavailable locally, so the new real MongoDB/Kafka/RabbitMQ/Redis/BullMQ integration suite was not executed. Container builds, Kubernetes deployment, restore/capacity/security acceptance and live-provider certification remain open.

CRM and advertising destinations are explicitly **simulators**. Meta, Google and Zoho adapters are not implemented or certified by this revision. A source package or passing mock test cannot close those provider gates.

Draft PR #1 must remain unmerged until the complete corrected source and lockfile are published, clean-checkout CI passes, and all release-relevant integration and operational gates have evidence. The branch does not claim production readiness or immunity from failures.
