---
name: api-contract-review
description: Use when reviewing the design of a REST/HTTP API in ASP.NET Core — resource modeling, status codes, error shape, idempotency, versioning, pagination, and OpenAPI accuracy — before it ships.
---

# API Contract Review

Directs the agent to review the HTTP contract of an ASP.NET Core API end-to-end: verb semantics, status-code correctness, error shape, idempotency guarantees, concurrency, versioning strategy, pagination bounds, and whether the OpenAPI document faithfully describes the real responses — producing a concrete, API-named finding for every gap before the contract becomes load-bearing for clients.

## When to use

- A new REST endpoint, controller, or minimal-API handler is being added or modified and the HTTP contract must be reviewed before client teams depend on it.
- A PR changes a response shape, status code, or route and backward-compatibility risk must be assessed.
- An API is about to ship to external consumers and the OpenAPI document needs to be validated against real behavior.
- A code review reveals ad-hoc error JSON, missing `Location` headers on creates, or unbounded list endpoints.

## Process

1. **Enumerate the resources and verbs.** List every route, its HTTP method, and what resource it operates on. Confirm verb semantics: GET is safe and idempotent (no side effects), POST creates or triggers, PUT is a full idempotent replace, PATCH is a partial update, DELETE is idempotent.
2. **Check status-code correctness for every outcome.** Map each success and error path to the correct status code: `201 Created` + `Location` on create, `204 No Content` on empty success, `400` for malformed input, `422` for semantically invalid input, `409` for conflict, `404` vs `403` for missing vs forbidden, `412` for failed precondition.
3. **Check the error contract.** Confirm all error responses use `ProblemDetails` or `ValidationProblemDetails` (RFC 7807) via `Results.Problem`, `Results.ValidationProblem`, or `AddProblemDetails`. Flag any ad-hoc `{ "error": "..." }` bodies or non-standard error shapes.
4. **Check idempotency and verb safety.** For unsafe, non-idempotent POSTs that have real-world side effects (payments, orders, emails) confirm an `Idempotency-Key` request header is accepted and the server deduplicates replayed requests. Confirm PUT and DELETE operations are genuinely idempotent (repeated calls return the same result).
5. **Check versioning, pagination, and content negotiation.** Verify an explicit versioning strategy (`Asp.Versioning` URL segment or header). Verify all list endpoints have a bounded page size, and return a cursor or offset with a documented `next` token or `Link` header. Confirm the `Accept` header is honored and media types are consistent.
6. **Check the OpenAPI document matches reality.** Confirm every status code emitted by the handler is declared via `[ProducesResponseType]` (controllers) or `.Produces<T>(statusCode)` (minimal APIs), the document is generated with `Microsoft.AspNetCore.OpenApi` or Swashbuckle, and response schemas reference DTOs not EF entities.
7. **Output findings with the concrete fix.** For each gap, name the exact type, attribute, or method to apply. Re-check the same pattern in sibling handlers before closing.

## .NET / Azure checks

- **Verb semantics.** GET must be safe and idempotent — no mutations, no visible side effects. POST creates a new resource or triggers a non-idempotent action. PUT performs a full, idempotent replace of a named resource (same outcome for repeated calls). PATCH applies a partial update via `JsonPatch` (`Microsoft.AspNetCore.JsonPatch`) or JSON merge-patch (`Content-Type: application/merge-patch+json`). DELETE is idempotent — deleting an already-deleted resource must return `204` or `404`, not `500`.
- **Status codes.** `201 Created` with a `Location: /resource/{id}` header on every successful POST that creates a resource. `204 No Content` on mutations with no body to return. `400 Bad Request` for syntactically malformed input (unparseable JSON, wrong content-type, missing required header). `422 Unprocessable Entity` for input that is well-formed but semantically invalid (a date range where end < start, a reference to a non-existent foreign key). `409 Conflict` for state conflicts (optimistic-concurrency collisions, duplicate resource creation). `404 Not Found` when the resource does not exist; `403 Forbidden` when it exists but the caller lacks permission. `412 Precondition Failed` when `If-Match` does not match the current ETag.
- **Error contract — RFC 7807 ProblemDetails.** All error responses must conform to RFC 7807: `Content-Type: application/problem+json`, fields `type`, `title`, `status`, `detail`, `instance`. Use `Results.Problem(detail, statusCode: 400)` (minimal APIs) or `return Problem(detail: ..., statusCode: 400)` (controllers). For validation errors, use `Results.ValidationProblem(errors)` or `return ValidationProblem(ModelState)` — this returns `ValidationProblemDetails` with an `errors` dictionary, status `422`, and the correct content type. Register `builder.Services.AddProblemDetails()` to get a consistent default problem response for unhandled exceptions. Never return `{ "error": "..." }`, `{ "message": "..." }`, or any other ad-hoc JSON shape on error.
- **Idempotency-Key for non-idempotent POSTs.** Any POST that charges a payment, creates an order, sends a message, or otherwise has an irreversible side effect must accept an `Idempotency-Key: <uuid>` request header. The server stores the key and the response; repeated requests with the same key return the cached response without re-executing the side effect. Clients must be able to safely retry on network errors. Without this, a transient failure during a payment POST causes a double-charge.
- **Optimistic concurrency with ETag + If-Match.** Resources that can be concurrently updated must emit an `ETag` response header (a version hash or row-version value). Update operations (PUT/PATCH) must require the client to send `If-Match: "<etag>"`. If the stored version does not match, return `412 Precondition Failed` (not `409`). This prevents a lost-update race between concurrent writers. In ASP.NET Core, read `Request.Headers.IfMatch` and compare against `entry.RowVersion` or a computed hash.
- **API versioning via Asp.Versioning.** Every public API route must be versioned. Use the `Asp.Versioning` NuGet package (`Microsoft.AspNetCore.ApiVersioning`). Prefer URL-segment versioning (`/v{version:apiVersion}/`) for public APIs; header versioning (`api-version: 2.0`) for internal or partner APIs. Declare versions on controllers with `[ApiVersion("1.0")]` and deprecate old versions with `[ApiVersion("1.0", Deprecated = true)]`. Making a breaking change on an unversioned route is never acceptable.
- **Bounded pagination.** No list endpoint may return an unbounded collection. Require `pageSize` (or `limit`) with a maximum cap enforced server-side (e.g. `Math.Min(pageSize, 100)`). For offset-based pagination return `{ "items": [...], "nextPage": "/orders?skip=20&limit=20" }`; for cursor-based return an opaque `nextCursor` token. Document the `next` token or `Link: <url>; rel="next"` header in the OpenAPI spec.
- **OpenAPI document accuracy.** Generate the document with `Microsoft.AspNetCore.OpenApi` (`builder.Services.AddOpenApi()`, `app.MapOpenApi()`) or Swashbuckle (`builder.Services.AddSwaggerGen()`). Every handler must declare `[ProducesResponseType<CreateOrderResponse>(StatusCodes.Status201Created)]`, `[ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status422UnprocessableEntity)]`, etc. Response schemas must reference DTOs, not EF entity classes. Undocumented status codes confuse client code generators and SDK authors.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `200 OK` returned with an error body (e.g. `{ "success": false, "error": "..." }`) | Clients cannot distinguish success from failure by status code; HTTP semantics are broken and SDK generators produce incorrect code. |
| `POST /orders` returns `200` with no `Location` header on success | Violates RFC 7231 §6.3.2; the caller has no reliable way to retrieve the created resource without parsing the body or issuing a second query. |
| An error response with `Content-Type: application/json` and a plain `{ "error": "..." }` body | Not RFC 7807; different endpoints expose different error shapes, making client error-handling inconsistent and fragile. |
| A list endpoint with no `pageSize` parameter or no server-side cap | A single request can return millions of rows; causes OOM on the server and a large, slow payload for the client. |
| An unversioned public route accepting breaking changes in-place | Any client that has not opted in to the new behavior breaks silently; there is no way to communicate the change or deprecate safely. |
| `PUT /resource/{id}` used for partial updates instead of `PATCH` | PUT semantics require a full replace; sending a partial body causes unset fields to be nulled out, silently corrupting data. |
| EF entity class (e.g. `Order`, `ApplicationUser`) returned directly as the response DTO | Exposes server-managed columns (`RowVersion`, `PasswordHash`, `IsDeleted`, foreign-key navigations) and couples the wire contract to the database schema. |
| `422` status code undeclared in the OpenAPI document | Code generators emit no error type for validation failures; client developers discover the shape at runtime from an unexpected response. |

## Example

See [`examples/api-contract-review/`](../../examples/api-contract-review/) and the full before/after walkthrough in [`examples/api-contract-review/README.md`](../../examples/api-contract-review/README.md).

## Related skills

- [design-dotnet-feature](../design-dotnet-feature/SKILL.md) — use first to validate the feature design and resource model before reviewing the HTTP contract in detail.
- [auth-flow-review](../auth-flow-review/SKILL.md) — review authorization on every endpoint produced by this contract: scopes, policies, and default-deny posture.
- [rate-limiting-review](../rate-limiting-review/SKILL.md) — once the contract is correct, review 429 semantics and Retry-After header contract for protected endpoints.
