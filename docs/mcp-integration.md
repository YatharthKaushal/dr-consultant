# MCP Integration Guide

How an external AI client connects to this platform's tool surface over the
Model Context Protocol.

Audience: an integrator building an automation client (for example a
messaging aggregator) that will call these tools on a patient's behalf.

---

## 1. What this surface is — and is not

**This surface performs navigation, not diagnosis.**

Every tool here answers a *routing* question: what kinds of professional does
this platform offer, what does each cost, which doctors are available, and
which type of professional handles the sort of difficulty a patient has
described. The concern labels returned by `discover_care` are drawn from a
curated, clinically-governed taxonomy of service categories. They are
**not clinical findings**, they are not a triage score, and they are not a
statement about what is wrong with anyone (SRS §2.4, §8).

An integrator must therefore never present a tool result as a diagnosis, a
severity assessment, or medical advice. The correct framing to a patient is
"here is the kind of professional who handles this, and here are some you
could book", never "you have X".

Doctors are selected **deterministically** — by filter and by the platform's
own ordering. No model ranks or personalises them. Present a doctor list as a
set of options, not as a recommendation.

---

## 2. Endpoint

```
POST https://<host>/api/mcp
```

- **Protocol:** Model Context Protocol, **Streamable HTTP** transport.
- **Mode:** stateless. No session id is issued and none is required; do not
  send `Mcp-Session-Id`.
- **Responses:** plain JSON (`application/json`), not an SSE stream.
- **Methods supported:** `initialize`, `tools/list`, `tools/call`.

Send `Accept: application/json, text/event-stream` (the MCP spec requires the
client to advertise both) and `Content-Type: application/json`.

The surface can be switched off per deployment (`mcp.enabled`, §7). While it
is off, every request is answered `503 MCP_DISABLED`.

---

## 3. Authentication

Every request carries a client key:

```
Authorization: Bearer mcp_<key>
```

Keys are issued per integration by a platform administrator. They identify a
**machine, not a person** — a key is not a user account and carries no
patient, doctor or admin identity.

### Key handling

- The plaintext key is shown **exactly once**, in the response that creates
  the client. It is stored only as a salted scrypt digest, and **no endpoint
  returns it again** — not the listing, not the detail read, not an update.
- If a key is lost, it cannot be recovered. Create a new client.
- If a key is exposed, ask the administrator to deactivate the client; the key
  stops working immediately.

### Authentication failures

All authentication failures — missing header, wrong scheme, unknown key,
wrong key, deactivated client — return the **same** response. This is
deliberate: the response never reveals which check failed.

```http
HTTP/1.1 401 Unauthorized
```
```json
{ "success": false, "error": { "code": "MCP_UNAUTHENTICATED", "message": "Invalid or missing MCP client key." } }
```

---

## 4. Scopes

Each client is granted a list of tool names it may call. A tool outside a
client's scopes is **not visible and not callable**:

- `tools/list` does not include it.
- `tools/call` answers exactly as it would for a tool that does not exist.

That equivalence is intentional — an out-of-scope call must not confirm that
the tool is real. Both cases produce:

```json
{ "result": { "content": [ { "type": "text", "text": "MCP error -32602: Tool <name> not found" } ], "isError": true }, "jsonrpc": "2.0", "id": 4 }
```

Call `tools/list` to discover what your key can actually do; do not assume a
tool named in this document is in your scopes.

---

## 5. Error shapes

Two distinct layers, because they fail for different reasons.

### 5.1 Transport-level — HTTP status + platform envelope

Refused **before** the MCP protocol is entered: the surface is off, the key is
bad, or the client is over its request budget.

| HTTP | `error.code` | Meaning |
|---|---|---|
| 401 | `MCP_UNAUTHENTICATED` | Missing, malformed, unknown or revoked key. |
| 429 | `MCP_RATE_LIMITED` | Request budget exhausted. Carries `retryAfterSeconds`. |
| 503 | `MCP_DISABLED` | The MCP surface is not enabled on this deployment. |

```json
{ "success": false, "error": { "code": "MCP_RATE_LIMITED", "message": "Rate limit exceeded: at most 120 requests per 60 seconds.", "retryAfterSeconds": 60 } }
```

### 5.2 Tool-level — HTTP 200 + MCP error result

The call was well-formed and authorised, but the tool could not answer. These
come back as an MCP tool error (`isError: true`), **not** a JSON-RPC protocol
error, because your agent needs to read the reason and decide what to do.

```json
{ "result": { "content": [ { "type": "text", "text": "{\"error\":{\"code\":\"SPECIALTY_NOT_FOUND\",\"message\":\"No active specialty matches that id or code.\"}}" } ], "isError": true }, "jsonrpc": "2.0", "id": 7 }
```

| `code` | Meaning |
|---|---|
| `SPECIALTY_NOT_FOUND` | No active specialty matches the id or code given. |
| `DISCOVERY_UNAVAILABLE` | Symptom discovery is not bound in this deployment. |
| `CATALOGUE_CAPABILITY_UNAVAILABLE` | The concern taxonomy is not available in this deployment. |
| `DOCTOR_DIRECTORY_UNAVAILABLE` | The doctor directory is not available in this deployment. |

Argument validation failures also arrive as tool errors, produced by the MCP
SDK against each tool's declared JSON Schema:

```
MCP error -32602: Input validation error: Invalid arguments for tool get_service_details: Invalid input: expected string, received number at specialtyId
```

---

## 6. Rate limiting

Per client, counted in a trailing window. Defaults: **120 requests per 60
seconds** (both administrator-configurable, so read the values from the
`MCP_RATE_LIMITED` message rather than hard-coding them).

The count is per authenticated client, not per IP. Requests that fail
authentication are not counted. A refused request does not itself consume
budget, so being rate-limited never deepens the lockout.

On a 429, wait `retryAfterSeconds` before retrying.

---

## 7. Deployment switch

The surface is controlled by the `mcp.enabled` platform setting and is
**disabled by default**. An administrator must turn it on explicitly. Anything
other than a literal boolean `true` is treated as off.

---

## 8. Tools

### 8.1 `list_service_catalogue`

Every type of mental-health professional the platform offers.

**Input:** none.

```json
{}
```

**Output**

```json
{
  "specialties": [
    { "id": "1f3c…", "code": "psychiatry", "name": "Psychiatry",
      "description": "Medical treatment of mental health conditions.", "canPrescribe": true },
    { "id": "8a21…", "code": "counselling", "name": "Counselling",
      "description": "Supportive talking therapy.", "canPrescribe": false }
  ]
}
```

Returns the catalogue only — no doctors, no prices, no availability.

---

### 8.2 `list_concern_taxonomy`

The named problem areas the platform treats, grouped under the professional
type that handles each.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `specialtyId` | uuid | no | Return only concerns under this specialty. |

```json
{ "specialtyId": "1f3c…" }
```

**Output**

```json
{
  "concerns": [
    { "id": "c1…", "specialtyId": "1f3c…", "code": "sleep", "name": "Sleep" },
    { "id": "c2…", "specialtyId": "1f3c…", "code": "anxiety", "name": "Anxiety" }
  ]
}
```

**This tool returns names and codes only.** It deliberately does not expose
the phrase list used to match a patient's description to a concern, nor the
weights used to rank those matches. That mapping is clinically governed and
authoritative (SRS §7): symptom-to-specialty routing is a decision the
platform owns, audits and can defend.

Do not attempt to reproduce that matching yourself from this list. Call
`discover_care` and use the concerns it returns.

---

### 8.3 `get_service_details`

One professional type in full: what it is, what it costs, who offers it.

**Input** — supply `specialtyId` **or** `specialtyCode`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `specialtyId` | uuid | one of | From `list_service_catalogue`. |
| `specialtyCode` | string | one of | e.g. `"psychiatry"`. |

```json
{ "specialtyCode": "psychiatry" }
```

**Output**

```json
{
  "specialty": { "id": "1f3c…", "code": "psychiatry", "name": "Psychiatry",
                 "description": "Medical treatment of mental health conditions.", "canPrescribe": true },
  "directory": {
    "doctorCount": 12,
    "feeRangeInr": { "min": "800.00", "max": "2400.00" },
    "languages": ["English", "Hindi", "Tamil"]
  }
}
```

Read `directory` carefully — it has three distinct states:

| Value | Meaning | What to tell the patient |
|---|---|---|
| an object with `doctorCount > 0` | Real aggregates. | Quote the range. |
| `doctorCount: 0`, `feeRangeInr: null` | Nobody currently offers this specialty. | "No one is available for this at the moment." |
| `directory: null` | The doctor directory could not be read. | "I can't look up fees right now." **Never guess a price.** |

Fees are decimal strings in INR, exactly as stored.

---

### 8.4 `list_doctors`

A filtered directory listing.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `specialtyId` | uuid | no | Only doctors offering this specialty. |
| `language` | string | no | Exact match, e.g. `"Hindi"`. |
| `maxFeeInr` | integer > 0 | no | Inclusive upper bound on the fee. |
| `limit` | integer 1–50 | no | Default 10. |

```json
{ "specialtyId": "1f3c…", "language": "Hindi", "maxFeeInr": 1500, "limit": 5 }
```

**Output**

```json
{
  "doctors": [
    { "id": "d1…", "fullName": "Dr Asha Rao", "bio": "Fifteen years in adult psychiatry.",
      "languages": ["English", "Hindi"], "qualification": "MD Psychiatry",
      "yearsOfExperience": 15, "consultationFeeInr": "1500.00",
      "consultationDurationMinutes": 30,
      "specialties": [ { "id": "1f3c…", "code": "psychiatry", "name": "Psychiatry", "isPrimary": true } ] }
  ]
}
```

Results are a plain filtered listing in the platform's own order. They are
**not ranked or personalised**. An empty list means nothing matched — it is
not an error.

---

### 8.5 `discover_care`

The main entry point when a patient describes a problem in their own words.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string, 1–2000 | **yes** | The patient's own wording. |
| `locale` | string | no | BCP-47, e.g. `"hi-IN"`. |
| `limit` | integer 1–50 | no | Default 10. |

```json
{ "text": "I haven't been able to sleep for weeks and I feel on edge all the time", "locale": "en-IN" }
```

Pass the patient's wording through **unchanged**. Do not summarise it,
translate it, tidy it up, or decide the specialty yourself — this tool makes
that decision.

**Output — two shapes, discriminated by `outcome`.**

Routed:

```json
{
  "outcome": "routed",
  "concerns": [ { "id": "c1…", "code": "sleep", "name": "Sleep" },
                { "id": "c2…", "code": "anxiety", "name": "Anxiety" } ],
  "recommendedSpecialties": [
    { "id": "1f3c…", "code": "psychiatry", "name": "Psychiatry",
      "description": "Medical treatment of mental health conditions.", "canPrescribe": true } ],
  "doctors": [ /* same shape as list_doctors */ ],
  "matchReason": "matched to: sleep, anxiety"
}
```

Crisis — see §9, which you must read before integrating this tool:

```json
{
  "outcome": "crisis",
  "guidance": {
    "message": "If you are thinking about harming yourself, please contact emergency services now.",
    "helplines": [ { "name": "Tele-MANAS", "phone": "14416", "availability": "24x7" } ]
  },
  "doctors": []
}
```

---

## 9. The crisis-response contract

**Read this section before shipping any integration that calls
`discover_care`.**

When the platform's discovery pipeline detects that a patient may be in
crisis, `discover_care` returns `outcome: "crisis"` carrying **emergency
guidance and an empty doctor list**. There are no concerns, no recommended
specialties, and no doctors in that response. There is nothing in it but the
guidance.

That is by design. We cannot compel a third-party client to display our
emergency message, respect an ordering, or honour a warning flag — anything we
returned alongside the guidance would be something a client might render
*instead* of it. So the mitigation is structural rather than advisory: on a
crisis result there is nothing else to show.

### What an integrator MUST do

1. **Render `guidance.message` to the patient, as written.** Do not summarise
   it, rephrase it, translate it, shorten it, or fold it into a longer reply.
2. **Render `guidance.helplines`** — the name and phone number of each.
3. **Offer nothing else in that turn.** No doctors, no appointment slots, no
   "would you like to book instead", no upsell, no follow-up question that
   moves the conversation on.
4. **Do not re-query.** Do not call `list_doctors`, `get_service_details` or
   `discover_care` again to "get past" the crisis result and obtain a doctor
   list. The empty list is the answer, not a failure to be retried.
5. **Check `outcome` before anything else.** Branch on it first, before
   touching `concerns`, `recommendedSpecialties` or `doctors`.

### What an integrator MUST NOT do

- Suppress, truncate or replace the guidance message.
- Treat `doctors: []` as an empty-search result and apologise for finding no
  doctors — it is not a search failure.
- Continue an automated booking flow.

An integration that does not honour this contract is not a conforming
consumer of this surface, and access may be revoked.

---

## 10. Worked example

```bash
# 1. Discover what your key can call
curl -sX POST https://<host>/api/mcp \
  -H 'Authorization: Bearer mcp_…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 2. Call a tool
curl -sX POST https://<host>/api/mcp \
  -H 'Authorization: Bearer mcp_…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"get_service_details","arguments":{"specialtyCode":"psychiatry"}}}'
```

Tool results arrive as a JSON string in `result.content[0].text`; the same
object is also provided as `result.structuredContent`.

---

## 11. Administration (platform-side)

Clients are managed by an administrator over the admin API. `mcp.read` is
required to view them; `mcp.manage` — held by super administrators only,
because it hands an outside party live access to catalogue and doctor data —
is required for every mutation.

| Method | Path |
|---|---|
| `GET` | `/api/admin/mcp/clients` |
| `GET` | `/api/admin/mcp/clients/:id` |
| `POST` | `/api/admin/mcp/clients` |
| `PATCH` | `/api/admin/mcp/clients/:id` |
| `DELETE` | `/api/admin/mcp/clients/:id` |

Creating a client is the one and only time a key is returned:

```json
{ "success": true, "data": {
    "client": { "id": "…", "name": "WhatsApp aggregator", "keyPrefix": "mcp_uEFocO8d",
                "keyLast4": "DHqQ", "scopes": ["list_service_catalogue"], "isActive": true,
                "lastUsedAt": null, "createdAt": "…", "updatedAt": "…" },
    "plaintextKey": "mcp_…" } }
```

Deactivating (`PATCH { "isActive": false }`) is the revocation path: the key
stops working immediately while the client's audit history is preserved.
Every mutation is written to the audit log with before/after state, and never
includes key material.
