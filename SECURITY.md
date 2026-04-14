# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Neon Scoreboard, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainer directly or use GitHub's private vulnerability reporting feature.

## Scope

This project runs a local web server and uses a headless browser to scrape public match data from ESSPortal. Security considerations include:

- **No user authentication** — The app is designed for local/single-user use
- **No database** — No persistent storage of sensitive data
- **Input validation** — Match URLs are validated before processing
- **No secrets** — reCAPTCHA site keys are public (provided by ESSPortal's client-side code)

## Best Practices for Deployment

- Run the app on `localhost` only (default behavior)
- Do not expose the app to the public internet without adding authentication
- Keep Node.js and dependencies updated (`npm audit`)
