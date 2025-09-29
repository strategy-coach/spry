# Spry Assembler & Backend-as-a-Service Layer for SQLPage

Spry for SQLPage is a lightweight backend-as-a-service (BaaS) built on top of
[SQLPage](https://sql.ophir.dev) using Spry's language-agnostic light weight
source code discovery and materialization framework.

SQLPage is already an excellent framework that lets you build applications
directly out of `.sql` files. Spry takes SQLPage further: it adds opinionated
structure, templating, and orchestration features that make SQLPage projects
easier to manage, scale, and integrate into larger systems.

Spry is inspired by modern BaaS platforms like Supabase, PocketBase, and
Trailbase. But instead of hiding your backend behind abstractions, Spry keeps
things transparent: it scaffolds `.sql` pages directly, so your backend stays
simple, portable, and hackable.

## Why Spry?

SQLPage on its own is powerful, but as projects grow it needs a companion layer
to stay maintainable. As of v0.37, SQLPage provides templates and components but
no strong opinion on project structure. That’s where Spry comes in.

Spry is designed for teams who want SQLPage to work like a modern BaaS platform,
but without giving up transparency:

- Inspired by BaaS platforms, built for SQLPage Spry delivers the productivity
  of Supabase or PocketBase, but through SQLPage itself.
- Generates type-safe `.sql` files Spry scaffolds code for you, reducing
  boilerplate and errors while keeping everything human-readable.
- Adds authentication and APIs out of the box Role-based access, session
  handling, and CRUD endpoints are ready with minimal setup.
- Portable and transparent Runs anywhere SQLPage and SQLite/Postgres can run.
  Outputs are `.sql` files you can inspect, version, and extend.
- Scales with your needs Works for simple dashboards, but also supports larger
  orchestration workflows with templates, navigation trees, and generated
  content.

## What Spry Provides

### Backend as a Service

- Authentication and Authorization Built-in session handling, login, and
  role-based access control through SQLPage templates.

- APIs and Data Access CRUD endpoints scaffolded automatically from your
  database schema.

- Realtime subscriptions _(planned)_ Push updates directly from the database
  into apps.

- Admin console scaffolding _(planned)_ Auto-generated management interfaces for
  your schema.

### Orchestration and Templating

- Annotations (`@…`) are blueprints that describe how files behave.
- Directives (`#…`, `!…`) are assembly instructions that insert layouts,
  headers, or other code inline.
- Foundries are production shops — external scripts that generate
  SQL/JSON/Markdown which Spry captures and saves into stores (`spry.d/auto/*`
  and the `sqlpage_files` table).
- Stores act as warehouses for reproducible outputs.

This orchestration model gives SQLPage the consistency and build pipeline
features you’d expect from a static site generator (SSG), but applied to
data-driven `.sql` applications.

## Who Benefits

- Senior Executives Gain lower-cost backends with shorter delivery times.
  SQLPage + Spry reduces reliance on heavy frameworks while keeping systems
  auditable and simple.

- Project Leaders & Product Managers Get reproducible builds, consistent
  navigation, and scaffolded APIs without needing extra infrastructure. It
  reduces coordination overhead across teams.

- Data Analysts Focus on writing SQL queries and reports. Spry handles page
  structure, layouts, and even auto-generates endpoints when needed.

- Engineering Leaders Encourage modularity and good practice: annotations for
  metadata, directives for inline transformations, foundries for integrations.
  Spry keeps codebases clean and projects reproducible.

## Major Benefits

SQLPage is already superb at rendering applications directly from SQL. Spry adds
the opinionated orchestration and BaaS features that larger projects need:

- Scaffolding for authentication, APIs, and CRUD endpoints.
- Navigation, layouts, and templating from annotations and directives.
- Reproducible builds and outputs materialized into predictable stores.

Spry yields:

- Faster delivery — teams scaffold APIs, authentication, and layouts instead of
  coding them from scratch.
- Lower maintenance risk — reproducible builds and transparent `.sql` files make
  systems easy to debug.
- Greater flexibility — use SQLPage as intended, but add templating,
  orchestration, and BaaS-like features when projects scale.
- Portability — runs anywhere SQLPage runs (local, cloud, or embedded
  environments).

With Spry, SQLPage projects move beyond prototypes into production-ready
applications that remain transparent, maintainable, and scalable.

Great — here’s a business-friendly one-page comparison table that highlights the
incremental value Spry adds on top of SQLPage. It’s written for senior execs,
PMs, analysts, and engineering leaders.

# How SQLPage + Spry are better than SQLPage Alone

| Area                            | SQLPage Alone (v0.37)                                                | SQLPage + Spry                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Core purpose                    | Build apps directly in `.sql` files with components and templates.   | Orchestration & backend-as-a-service layer that structures, extends, and scales SQLPage projects.                               |
| Navigation & structure          | Manual — developers must define routes and breadcrumbs in each file. | Annotations (`@route`) describe navigation; Spry auto-generates routes, breadcrumbs, and consistency across all pages.          |
| Layouts & reusability           | Limited to what is written directly into each `.sql` file.           | Directives (`#include`, `!inject`) let teams reuse layouts, headers, and snippets without copy-paste.                           |
| Integration with external tools | Not built-in — must manually run scripts and paste outputs.          | Foundries (executable scripts in any language) generate SQL/JSON/Markdown. Spry captures and stores their output automatically. |
| Reproducibility                 | Each developer must manage their own files; outputs may differ.      | Deterministic builds: all outputs materialized into `spry.d/auto/*` and the `sqlpage_files` table. Easy to audit and deploy.    |
| APIs & CRUD endpoints           | Must be hand-written as `.sql` files.                                | Spry scaffolds type-safe API and CRUD endpoints directly from your database schema.                                             |
| Authentication                  | Must be coded manually.                                              | Built-in scaffolding for authentication, session handling, and role-based access.                                               |
| Realtime & admin console        | Not supported directly.                                              | Roadmap includes realtime subscriptions and auto-generated admin console scaffolding.                                           |
| Deployment readiness            | `.sql` files can be deployed as-is.                                  | Spry produces deployment-ready `.sql` files plus consolidated build artifacts and reports.                                      |
| Portability                     | Runs wherever SQLPage + SQLite/Postgres can run.                     | Same portability, but with structured outputs and reproducible builds that scale better for teams.                              |

## Key Takeaway

- SQLPage alone is excellent for small apps, dashboards, or proof-of-concepts.
- SQLPage + Spry turns those same projects into production-ready, maintainable
  applications by adding structure, reproducibility, reusable layouts, APIs,
  authentication, and integrations.

Spry encourages you to use SQLPage exactly as designed — but helps your team
scale projects confidently without adding complexity.
