# Maturity governance local testing

The nightly workflow evaluates only rows where `tool_maturity.status = 'verified'`. Use a disposable tool and developer account. The script uses the Supabase service role and can change badge state.

## Configuration

Set these environment variables before running the script:

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export GITHUB_TOKEN="..."
export NOTIFICATION_API_URL="https://YOUR_PPTB_WEB/api/internal/maturity-notification"
export TOOL_ID="TEST_TOOL_UUID"
```

`NOTIFICATION_API_URL` must accept a `POST` with this shape, resolve the developer's email from `developerId`, send the email, and return a 2xx response:

```json
{
  "event": "revoked_cve",
  "developerId": "uuid",
  "toolId": "uuid",
  "toolName": "Test Tool",
  "details": {}
}
```

Possible events are `revoked_cve`, `revoked_csp_exception`, `bug_health_grace_started`, `revoked_grace_expired_bug_health`, `api_breaking_change_grace_started`, and `revoked_grace_expired_api_breaking`.

Run `DRY_RUN=true node buildScripts/maturityGovernance.js` first to inspect decisions without writes or emails. `NOTIFICATION_API_URL` and its secret are not required when `DRY_RUN=true`. Local fixtures replace only npm audit and GitHub issue responses; Supabase reads and writes remain real.

## Reset the test tool

Run this in the Supabase SQL editor between scenarios:

```sql
update tool_maturity
set status = 'verified',
    last_change_reason = 'reinstated',
    last_changed_at = now(),
    updated_at = now(),
    verified_csp_exceptions_snapshot = '{"api.example.com":"required"}'::jsonb
where tool_id = 'TEST_TOOL_UUID';

update tools
set csp_exceptions = '{"api.example.com":"required"}'::jsonb
where id = 'TEST_TOOL_UUID';

delete from tool_grace_periods where tool_id = 'TEST_TOOL_UUID';
```

Replace `TEST_TOOL_UUID` in SQL and fixture files with the same UUID as `TOOL_ID`.

## 1. Critical or high CVE

Create `$TMPDIR/maturity-cve.json`:

```json
{
  "TEST_TOOL_UUID": {
    "audit": { "metadata": { "vulnerabilities": { "high": 1, "critical": 0 } } },
    "issues": []
  }
}
```

Run:

```bash
node buildScripts/maturityGovernance.js --fixtures "$TMPDIR/maturity-cve.json"
```

Expected: `tool_maturity.status = 'unverified'`, `last_change_reason = 'revoked_cve'`, `last_changed_at` changes, no grace row is created, and pptb-web receives `revoked_cve`.

## 2. New CSP exception

Reset the tool, then add a current exception without changing the approval snapshot:

```sql
update tools
set csp_exceptions = '{"api.example.com":"required","new.example.com":"new dependency"}'::jsonb
where id = 'TEST_TOOL_UUID';
```

Use a fixture with a clean audit:

```json
{
  "TEST_TOOL_UUID": {
    "audit": { "metadata": { "vulnerabilities": { "high": 0, "critical": 0 } } },
    "issues": []
  }
}
```

Expected: the tool becomes Unverified with `last_change_reason = 'revoked_csp_exception'`, no grace row is created, and pptb-web receives `revoked_csp_exception`.

## 3. Bug health

Reset the tool. Create a fixture containing one open bug created 11 days before the test time and no maintainer response. The dates must be relative to the current time when the script runs:

```json
{
  "TEST_TOOL_UUID": {
    "audit": { "metadata": { "vulnerabilities": { "high": 0, "critical": 0 } } },
    "issues": [
      { "created_at": "11_DAYS_AGO_ISO", "first_maintainer_response_at": null }
    ]
  }
}
```

Expected on the first run: the badge remains Verified, one active `bug_health` row has a deadline 14 days ahead, and pptb-web receives `bug_health_grace_started`. Five open bugs also produce this FLAG outcome. An unanswered bug older than 30 days records a BLOCKER in `related_detail` but uses the same grace-period lifecycle.

To simulate a fix, change `first_maintainer_response_at` to within 10 days of `created_at` (or remove/close the issue in the fixture) and rerun. Expected: the grace row becomes `resolved` and `resolved_at` is set.

To simulate expiry, keep the breach and backdate the active row:

```sql
update tool_grace_periods
set deadline_at = now() - interval '1 minute'
where tool_id = 'TEST_TOOL_UUID'
  and trigger_type = 'bug_health'
  and status = 'active';
```

Expected: the grace row becomes `expired_badge_removed`, the tool becomes Unverified with `last_change_reason = 'revoked_grace_expired_bug_health'`, and pptb-web receives the matching event.

## 4. PPTB API breaking change

The schema deliberately has no deprecations table, and this repository has no other release/deprecation data source. The release publisher must insert the grace row directly when a breaking release is published. The nightly job owns notification and expiry from that point.

To simulate an already-expired window, reset the tool and run:

```sql
insert into tool_grace_periods (
  tool_id, trigger_type, started_at, deadline_at, related_detail
) values (
  'TEST_TOOL_UUID',
  'api_breaking_change',
  now() - interval '15 days',
  now() - interval '1 day',
  '{"release":"test-breaking-release"}'::jsonb
);
```

Run the job. Expected: the grace row becomes `expired_badge_removed`, the tool becomes Unverified with `last_change_reason = 'revoked_grace_expired_api_breaking'`, and pptb-web receives the matching event.

For the active-window case, insert a future `deadline_at`. Expected: the badge remains Verified, pptb-web receives `api_breaking_change_grace_started` once, and `related_detail.governance_notified_at` prevents duplicate nightly messages. Mark the row `resolved` with `resolved_at = now()` when the tool is updated before its deadline.

## Verify outcomes

```sql
select status, last_change_reason, last_changed_at
from tool_maturity
where tool_id = 'TEST_TOOL_UUID';

select trigger_type, status, started_at, deadline_at, resolved_at, related_detail
from tool_grace_periods
where tool_id = 'TEST_TOOL_UUID'
order by created_at desc;
```

Confirm the corresponding request in pptb-web logs and the message in the test developer's inbox.