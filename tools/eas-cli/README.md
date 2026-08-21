# EAS release tool lock

This private npm project isolates the exact EAS CLI used to request signed store builds. It is not
part of the web or mobile application dependency graph.

On a trusted release checkout, install it explicitly with Node 24.19.0 and npm 11.16.0:

```bash
npm --prefix tools/eas-cli ci
```

Review `npm --prefix tools/eas-cli audit` before each release. The application release command uses
this installed lockfile copy with npm offline mode and must fail if the tool was not prepared. Do
not put EAS credentials in this directory or in npm configuration files.
