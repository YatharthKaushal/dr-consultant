# API endpoint test findings — identity, consent, patient, doctor, catalogue, availability

Produced while writing the first real-HTTP (`app.inject()`) endpoint tests for these six
modules. Each entry: route, exact request, exact failure observed, root cause, and
disposition (fixed with red/green proof, or found-and-not-fixed with reasoning).

Format per finding:

```
## <short title>
- Route: METHOD /api/...
- Request: <method/url/payload/headers that trigger it>
- Observed: <status code + response body, or stack trace>
- Root cause: <why>
- Disposition: FIXED <files changed, red/green proof> | NOT FIXED <why not — needs a
  design decision / risk too high / out of scope, etc.>
```

---
