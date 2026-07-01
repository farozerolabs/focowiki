# Security Policy

## Supported Versions

Security fixes are provided for the latest released version of Focowiki.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting flow when available:

https://github.com/farozerolabs/focowiki/security/advisories/new

When reporting a vulnerability, include:

- Affected version or commit.
- Deployment method, such as Docker Compose or local development.
- Steps to reproduce.
- Expected impact.
- Any relevant logs, screenshots, or request examples with secrets removed.

We will review valid reports, coordinate a fix, and publish release notes when a fix is available.

## Scope

Security reports may include issues in:

- Admin UI authentication and session handling.
- Admin API and Developer OpenAPI access control.
- Upload processing, generated files, and S3-compatible storage handling.
- Docker Compose deployment defaults.
- GitHub Actions release and publishing workflows.

Reports about unsupported local modifications, exposed user-managed secrets, or third-party services outside this repository may be closed as out of scope.
