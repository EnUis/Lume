# First checks after importing

Every imported playlist receives a small starter verification quota: up to three
distinct published titles in each movie, series, or live and MP4, HLS, DASH, or WebM
combination. At most 36 checks move ahead of the existing health queue. The quota
tries at most 12 distinct candidate titles per combination, so scheduling stays
bounded even when a consumer is checking sources concurrently.

The importer reads the earliest queued and running health job once and gives
starter checks an earlier queue time. Remaining checks keep their normal order.
This does not limit playlist size, imported sources, or eventual checks.

Only enabled, unknown sources that have never been checked can receive priority.
The job must be queued with zero attempts. Failed checks retain their retry delays;
running jobs keep their leases. Manually hidden or ambiguous titles do not receive
starter priority. Actual stream verification still controls public availability.

The snapshot records `starterVerificationVersion` and `starterChecks`. A snapshot
from before this policy is reconciled once even when its content bytes match.
