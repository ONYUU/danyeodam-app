# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, leaked credential, or privacy incident.
Use GitHub's private vulnerability reporting for this repository. Include the affected commit,
reproduction steps, and the minimum evidence needed to understand the impact. Do not include real
user data, production credentials, store-review credentials, or raw location coordinates.

## Public repository boundary

This repository contains source code and placeholder configuration only. Production secrets,
signing material, store credentials, reviewer credentials, raw user data, and private release
evidence must remain in their dedicated secret managers or store-console private fields.

The repository safety check runs on every pull request and push to `main`. GitHub secret scanning
and push protection are additional controls; neither replaces credential rotation after a suspected
exposure.
