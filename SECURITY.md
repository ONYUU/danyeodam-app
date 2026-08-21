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

## Static image review

Expo SDK 57.0.15's `@expo/metro` package still declares the Metro 0.84.4 family, which depends on an
upstream image parser with denial-of-service advisories. Meta imported the bounded parser replacement
into [Metro's source](https://github.com/facebook/metro/commit/ab65fa3d9fa0b75514bf26ef5e5f338c56cd2bc8),
and the stable 0.84.5 release removed that parser dependency. Metro's 0.84.5 backport was tested for
React Native 0.85 and 0.86, including an Expo fixture, so this repository pins all fourteen Metro
packages to exactly 0.84.5. Partial 0.84.4/0.84.5 mixtures are prohibited by the mobile
configuration tests, and the lockfile must not contain `image-size`.

The public repository also allows only the three reviewed mobile PNG brand assets whose path,
dimensions, byte limit, and SHA-256 digest are pinned in `scripts/lib/public-repo-safety.mjs`. This
defense-in-depth check runs before dependency installation and Metro export in Mobile CI. New or
changed static images must be reviewed and added to that allowlist in the same pull request; renamed
or disguised ICNS, JPEG XL, HEIF, and JPEG 2000 inputs are rejected. The override may be removed only
after Expo publishes a compatible dependency set that adopts Metro 0.84.5 or a later bounded-parser
release, followed by the same three-platform export verification. Main-branch alert closure remains
tracked in [GitHub issue #5](https://github.com/ONYUU/danyeodam-app/issues/5).

The release-only `eas-cli` is an exact devDependency and is executed from the lockfile with npm
offline mode. Its current upstream dependency graph has non-runtime advisories but no critical
advisory and no newer official EAS CLI release. Release operators must use a reviewed commit,
trusted local inputs, and a least-privilege EAS credential. Do not hide the findings with a dynamic
`npx` download, force an unsupported transitive override, or downgrade the EAS CLI.
