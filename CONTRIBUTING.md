# Contributing to Neon Scoreboard

Thank you for your interest in contributing! Here's how to get started.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install** dependencies with `npm install`
4. **Create a branch** for your change: `git checkout -b feature/my-feature`

## Development

```bash
# Start the dev server
npm start

# The app runs at http://localhost:5000
```

## Code Style

- Use `const`/`let` (never `var`)
- Use async/await over raw promises
- Keep functions focused — one responsibility per function
- Add console.log messages for debugging long-running operations
- Use descriptive error messages

## Pull Request Process

1. Ensure the app starts without errors (`npm start`)
2. Test with at least one real ESSPortal match URL
3. Update the README if you add new features or change behavior
4. Keep commits focused and write clear commit messages
5. Open a PR against `master` with a description of what changed and why

## Reporting Issues

- Use GitHub Issues
- Include the match URL you tested with (if applicable)
- Include any console output or error messages
- Describe what you expected vs. what happened

## Areas Where Help Is Needed

- **Export functionality** — CSV/PDF export of results
- **Testing** — Automated tests for scraping and calculation logic
- **Docker** — Containerized deployment
- **UI improvements** — Accessibility, theme toggle, animations
- **Performance** — Smarter caching, service worker support

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
