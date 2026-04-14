<div align="center">

# ⚡ Neon Scoreboard

**Real-time IPSC match results with true cross-division combined rankings**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<br>

*Paste an ESSPortal match URL → get instant division results and accurate combined rankings powered by hit-factor analysis across all divisions.*

</div>

---

## ✨ Features

- **🎯 Division Results** — View per-division standings with all competitor data (placement, score %, POM, category, class, region)
- **📊 True Combined Rankings** — Cross-division rankings using per-stage Hit Factor comparison (not division-relative percentages)
- **⚡ Parallel Fetching** — All divisions fetched simultaneously; combined calculates in ~30–60 seconds
- **🔒 reCAPTCHA Handling** — Automated reCAPTCHA v3 token generation via headless browser
- **🌙 Cyberpunk UI** — Glassmorphism design with neon gradients, smooth animations, and responsive layout
- **📱 Fully Responsive** — Works on mobile, tablet, and desktop
- **💾 Smart Caching** — Division data and combined rankings cached per session for instant re-access

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or higher
- Chromium (bundled with Puppeteer)

### Installation

```bash
# Clone the repository
git clone https://github.com/trbobubbla/neon-scoreboard.git
cd neon-scoreboard

# Install dependencies
npm install

# Start the server
npm start
```

The app will be running at **http://localhost:5000**

> **Tip:** To use a different port, set the `PORT` environment variable:
> ```bash
> PORT=3000 npm start
> ```

### Usage

1. Open the app in your browser
2. Paste an ESSPortal match URL (e.g. `https://portal.ipscess.org/portal/match/...`)
3. Click **Launch** to load and preload all division results
4. Click any **division button** to view that division's standings
5. Click **Combined** to see the true cross-division ranking

## 🏗️ Architecture

```
neon-scoreboard/
├── app.js              # Express server, scraping logic, combined calculation
├── views/
│   └── index.ejs       # Cyberpunk UI template (glassmorphism + neon)
├── package.json        # Dependencies and scripts
└── src/                # Legacy Python prototype (archived)
```

### How Combined Rankings Work

Standard IPSC portals only show division-relative standings — a shooter's "Score %" is relative to the best in their division. This makes cross-division comparison meaningless.

**Neon Scoreboard solves this** by:

1. Fetching the **stage view** (`?group=stage`) for each division
2. Extracting the **raw Hit Factor** (points ÷ time) for every shooter on every stage
3. For each stage, finding the **highest HF across all divisions**
4. Computing stage match points: `(shooter_HF / stage_max_HF) × 100`
5. Summing all stage points and ranking globally

This produces **accurate cross-division combined results** that truly reflect each shooter's performance relative to the entire field.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js + Express |
| **Templating** | EJS |
| **Scraping** | Puppeteer Extra + Stealth Plugin |
| **HTML Parsing** | Cheerio |
| **HTTP** | Axios |
| **UI** | Custom CSS (glassmorphism, neon gradients, animations) |

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `5000` | Server port |

### 🐳 Docker

```bash
docker build -t neon-scoreboard .
docker run -p 3000:3000 neon-scoreboard
```

Then open [http://localhost:3000](http://localhost:3000).

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📋 Roadmap

- [x] Export results to CSV
- [ ] Export results to PDF
- [ ] Match comparison (compare two match URLs)
- [x] Shooter search / table filter
- [x] Dark/light theme toggle
- [x] Docker container support
- [ ] Persistent result storage (SQLite)

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [ESSPortal](https://portal.ipscess.org/) — IPSC Electronic Scoring System
- [Puppeteer](https://pptr.dev/) — Headless browser automation
- [Cheerio](https://cheerio.js.org/) — Fast HTML parsing

---

<div align="center">

**Built with ☕ and 🎯 for the IPSC community**

</div>
