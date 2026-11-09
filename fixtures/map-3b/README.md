# Package map revision 3b regression evidence

`authorization-review.json` is a supplied Kubernetes SelfSubjectAccessReview
from `aegis-boutique-pilot`; the permission query returned `allowed: false`.
It is evidence content for local upload/routing tests, not a provider-coverage
record or a grant of access. No routing logic uses its filename.

The missing `source-0f8bffbef86143fb76576f44.json` was an app-assigned storage name.
The regression tests attach this file's bytes under a second source filename and
attach independent boxes to every family position. Production/preview storage
is not queried or changed.
