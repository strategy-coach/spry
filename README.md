# Spry

> A lightweight SQLPage-based backend-as-a-service

Spry is inspired by Supabase, PocketBase, and Trailbase, but it takes a different approach. It is a type-safe wrapper around [SQLPage](https://sql.ophir.dev) that helps generate `.sql` pages to deliver the same kind of backend services developers expect from a BaaS platform.

Spry makes SQLPage productive for app developers by scaffolding authentication, APIs, and CRUD endpoints while keeping the backend transparent and hackable.

## Why Spry

* Inspired by successful BaaS platforms but built directly on SQLPage
* Generates type-safe SQLPage `.sql` files so you avoid boilerplate
* Provides authentication, APIs, and data access out of the box
* Runs anywhere SQLPage and SQLite/Postgres can run
* Keeps your backend simple, portable, and inspection-friendly

## What Spry Provides

* Backend APIs: REST endpoints generated from your database schema
* Authentication and authorization: session handling and role-based access with SQLPage templates
* Realtime subscriptions (planned)
* Admin console scaffolding (planned)
* Deployment-ready `.sql` files that integrate seamlessly with SQLPage

## Quick Start

Install SQLPage (see [SQLPage documentation](https://sql.ophir.dev/install/)) and set up a SQLite or Postgres database. Then install Spry:

```bash
git clone https://github.com/your-org/spry.git
cd spry
deno task install
```

Initialize Spry in your project:

```bash
spry init myapp
```

This creates a `spry/` folder with type-safe `.sql` pages for auth, CRUD, and a basic API scaffold.

Run SQLPage against your project:

```bash
sqlpage serve
```

Open your browser at `http://localhost:8080` to see Spry in action.

Add your own tables and rerun:

```bash
spry generate schema.sql
```

Spry regenerates `.sql` pages to match your schema, giving you instant APIs.

Do you want me to also draft a **README outline** (features, roadmap, contributing, license) so that the repo looks fully fleshed out for first release?
