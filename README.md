# Backend

Doctor Consultation Platform, server side.

Related documents: `../docs/SRS.md` for requirements, `../docs/MODULES.md` for the module list and build order, `../docs/SCREENS.md` for screens.

---

## 1. Stack

- Runtime: Node.js 22
- Framework: NestJS 11 on the Fastify adapter
- Language: TypeScript, strict null checks on
- Database: PostgreSQL
- Data access: Drizzle ORM with drizzle-kit migrations
- Validation: zod for environment, class-validator for request DTOs
- Tests: Jest with ts-jest

NestJS carries the three things this architecture depends on: enforced module boundaries, dependency injection that lets a local call be swapped for a remote one, and a built-in TCP microservice transport.

Extraction path, when a module needs its own machines: run it as a NestJS TCP microservice and swap the local provider for a TCP client implementing the same facade interface. Callers do not change, because they only ever depended on the interface. TCP calls then need versioned patterns, timeouts, idempotency keys on anything that creates or charges, and a circuit breaker per client.

---

## 2. Modules and Boundaries

- One repository, one process, one database at launch: one deploy, one set of logs, no network hops between features. The code is still split by business domain, so a module that needs its own machines can leave later without a rewrite.
- A module owns its folder, its Postgres schema and its tables. No other module reads or writes them.
- Each module exposes one public surface, `<domain>.facade.ts`. No deep imports, no cross-module foreign keys, no cross-module transactions.
- Facade methods are async and pass plain JSON-safe objects, so a local call can become a network call untouched.
- Modules talk through a facade call or an event, with the outbox pattern for anything that must not be lost.
- `src/shared` and `src/config` are imported by modules and never import them. Controllers parse, authorise and delegate; services hold the rules; repositories hold the SQL; mappers keep DTOs and rows out of each other's layers.
- Modules are built one at a time in the order in `../docs/MODULES.md`. The next starts only when the current one is done: features working end to end against the real database, role and ownership checks on every endpoint, tests passing, migrations repeatable on a clean database, facade and contract defined, configuration read from the environment or admin settings, and the audit entries its specification requires.

---

## 3. Folder Structure

Folders appear as their module is built, in the order in `../docs/MODULES.md`.

- backend/
  - drizzle/ — generated migration files, committed
  - src/
    - main.ts — bootstrap, global pipes, shutdown hooks
    - app.module.ts — composition root, imports every module
    - config/
      - env/ — `env.validation.ts`, zod schema for all environment variables
      - db/ — `database.config.ts` pool lifecycle, `database.module.ts` global Drizzle provider
    - shared/
      - errors/ — error classes and the global exception filter
      - logging/ — logger and correlation ID middleware
      - auth/ — guards, decorators, role and ownership checks
      - events/ — event bus, event base types, outbox
      - audit/ — audit writer used by every module
      - rpc/ — transport abstraction, in-process dispatcher, TCP client factory
      - pagination/ — shared query and result helpers
      - types/ — shared primitives only, never domain types
    - modules/ — identity, consent, patient, doctor, catalogue, availability, ai, notification, search, document, booking, payment, presence, video, clinical, followup, clarification, carehub, feedback, governance, audit
    - health/ — `health.controller.ts`, `health.service.ts`, `health.module.ts`
  - test/ — end-to-end tests
  - .env.example
  - drizzle.config.ts
  - package.json

---

## 4. File Naming

- Every file is `<domain>.<role>.ts`, lower case and dot separated. Roles: `module`, `controller`, `rpc.controller`, `facade`, `contract`, `service`, `repository`, `schema`, `dto`, `types`, `mapper`, `events`, `constants`, `guard`, `spec`. Plus `index.ts`, which re-exports the facade and contract and nothing else.
- Class names mirror file names: `booking.service.ts` exports `BookingService`.
- Grow by feature keeping the domain prefix, `booking-slot-hold.service.ts`. A feature large enough to need its own tables is a new module, not a subfolder.
- Drizzle picks up every `*.schema.ts`. Each module declares its own Postgres schema with `pgSchema`, tables and columns in snake case, so extraction is a `pg_dump -n booking` and a stray cross-module join is obvious in review.
- Migrations are generated per change with `npm run db:generate` and committed. Never edit one that has been applied anywhere.
- Events are `<domain>.<past-tense-fact>`, for example `booking.confirmed`. Message patterns are `<domain>.v<version>.<action>`, for example `booking.v1.create`, versioned from the first day so a later change never breaks a running caller.
- Tests sit beside what they test as `.spec.ts`. End-to-end tests live in `test/` as `.e2e-spec.ts`.

---

## 5. Local Setup

- Copy `.env.example` to `.env.local` and fill in the values. The server validates the environment at boot and exits with the offending variable names if anything required is missing.
- Install with `npm install`, run with `npm run start:dev`, test with `npm test`.
- Migrations: `npm run db:generate`, `npm run db:migrate`, `npm run db:studio`.
- The API is served under the `/api` prefix. Health is at `/api/health`.
