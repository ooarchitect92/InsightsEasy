# InsightsEasy

## Five-service development on main

Business scope remains connections/intake, acquisition journeys, leads/CRM, revenue/attribution/reporting, and consent-controlled conversion feedback. Identity, gateway and execution workers support those five services.

The application source is being restored to main after the feature branch was merged. This commit publishes the frontend, service handlers, provider adapters and workers with clean-checkout build checks. Test suites and complete deployment configuration are restored in subsequent commits. This is development code, not a production release or a claim that all requested workflows have passed acceptance.

Runtime: Next.js/React, TypeScript, NestJS/Fastify, owner-scoped MongoDB, Kafka facts, RabbitMQ external-command workers, BullMQ report workers, separate queue/cache Redis. Provider credentials are server-side. External acceptance, processing, verification and ambiguous outcomes remain separate states.

The scoped Zoho Leads, Meta offline Purchase and Google Data Manager adapters require authorized account testing. Synthetic provider tests are not live certification. Native Meta enquiry intake, interactive authorization/discovery, authoritative CRM follow-up and other latest-specification gaps must not be advertised as complete from this baseline.

Local prerequisite: the Node version in `.nvmrc`. `npm ci --ignore-scripts`, `npm run lint` and `npm run build` are the initial clean-checkout checks. Production activation is not enabled by a passing build.
