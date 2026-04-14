const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const PDFDocument = require("pdfkit");
const Database = require("better-sqlite3");

puppeteer.use(StealthPlugin());

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- SQLite setup ---
const db = new Database(path.join(__dirname, "results.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(url)
  );
  CREATE TABLE IF NOT EXISTS match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    view TEXT NOT NULL,
    data TEXT NOT NULL,
    saved_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_match_results_match ON match_results(match_id, view);
`);

const isUrl = (value) => {
  return /^https?:\/\//i.test(value);
};

const parseHtmlTable = (table, $) => {
  const headers = [];
  table.find("tr").each((index, row) => {
    const ths = $(row).find("th");
    if (ths.length) {
      ths.each((_, th) => headers.push($(th).text().trim()));
    }
  });

  const records = [];
  table.find("tr").each((_, row) => {
    const cells = $(row).find("td, th");
    if (cells.length === 0) {
      return;
    }

    const values = [];
    const links = [];
    cells.each((_, cell) => {
      values.push($(cell).text().trim());
      const a = $(cell).find('a');
      if (a.length) {
        links.push(a.attr('href'));
      } else {
        links.push(null);
      }
    });

    const isHeaderRow = headers.length === values.length && values.every((value, index) => value === headers[index]);
    if (isHeaderRow) {
      return;
    }

    if (headers.length === values.length) {
      const record = {};
      headers.forEach((header, index) => {
        record[header || `column_${index + 1}`] = values[index] || "";
        if (links[index] && header.toLowerCase().includes('shooter')) {
          record.shooter_link = links[index];
        }
      });
      records.push(record);
    } else if (values.length >= 2) {
      records.push({ field: values[0], value: values.slice(1).join(" ") });
    }
  });

  return records;
};

const parseKeyValueList = ($, selector) => {
  const records = [];
  $(selector).each((_, node) => {
    const text = $(node).text().trim();
    const parts = text.split(":");
    if (parts.length >= 2) {
      const field = parts.shift().trim();
      records.push({ field, value: parts.join(":").trim() });
    }
  });
  return records;
};

const getRelativePath = (url) => {
  try {
    const parsed = new URL(url, "https://portal.ipscess.org");
    return parsed.pathname + parsed.search;
  } catch (_) {
    return url;
  }
};

const extractDivisionLinks = ($, baseUrl) => {
  const links = [];
  $(".list-group-item").each((_, node) => {
    const href = $(node).attr("onclick") || "";
    const match = href.match(/submitRecaptcha\(['"]([^'"\)]+)['"]/);
    if (match) {
      const divisionName = $(node).text().trim();
      const rawUrl = match[1];
      try {
        const absoluteUrl = new URL(rawUrl, baseUrl).toString();
        links.push({ name: divisionName, url: absoluteUrl, relativeUrl: rawUrl });
      } catch (_) {
        links.push({ name: divisionName, url: rawUrl, relativeUrl: rawUrl });
      }
    }
  });
  return links;
};

const fetchMatchOverview = async (url) => {
  const response = await axios.get(url, {
    headers: { "User-Agent": "ESSPortalReport/1.0" },
    timeout: 30000,
    responseEncoding: 'utf-8',
  });

  const $ = cheerio.load(response.data);
  const title = $("h1").first().text().trim() || url;
  const divisionLinks = extractDivisionLinks($, url);
  const verifyUrl = url + '/verify';
  return { title, divisionLinks, verifyUrl };
};

const launchBrowser = async () => {
  return await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
};

const fetchDivisionData = async (matchUrl, divisionName, divisionUrl, divisionRelativeUrl) => {
  const browser = await launchBrowser();
  let page;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(matchUrl, { waitUntil: "networkidle2", timeout: 60000 });
    const relativePath = divisionRelativeUrl || getRelativePath(divisionUrl);
    await page.waitForSelector("a.list-group-item-action", { timeout: 30000 });

    const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null);
    const clicked = await page.evaluate((absoluteUrl, relUrl) => {
      if (typeof window.submitRecaptcha !== "function") {
        return { success: false, error: "submitRecaptcha saknas på portal-sidan" };
      }
      const anchors = Array.from(document.querySelectorAll("a.list-group-item-action"));
      const target = anchors.find((el) => {
        const onclick = el.getAttribute("onclick") || "";
        return onclick.includes(absoluteUrl) || onclick.includes(relUrl);
      });
      if (!target) {
        return { success: false, error: "Kunde inte hitta matching division-knapp" };
      }
      target.click();
      return { success: true };
    }, divisionUrl, relativePath);

    if (!clicked.success) {
      throw new Error(clicked.error);
    }
    await navigationPromise;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Save first division HTML for debugging
    const fs = require('fs');
    if (!fs.existsSync(path.join(__dirname, 'debug-division-first.html'))) {
      fs.writeFileSync(path.join(__dirname, 'debug-division-first.html'), html, 'utf8');
      console.log(`Saved first division debug HTML for ${divisionName}`);
    }

    const table = $("table").first();
    let records = [];
    const shooterIds = new Set();
    if (table.length) {
      records = parseHtmlTable(table, $).map((record) => ({
        division: divisionName,
        source_url: divisionUrl,
        ...record,
      }));
      records.forEach(record => {
        // Primary: extract from the # column (competitor number)
        const numCol = record['#'];
        if (numCol) {
          const num = String(numCol).trim();
          if (/^\d+$/.test(num)) {
            shooterIds.add(num);
          }
        }
        // Fallback: extract from shooter link
        if (record.shooter_link) {
          const match = record.shooter_link.match(/\/shooter\/(\d+)/);
          if (match) {
            shooterIds.add(match[1]);
          }
        }
      });
      console.log(`Division ${divisionName}: extracted ${shooterIds.size} shooter IDs from ${records.length} records`);

      // Also fetch stage view in the same browser session for Total Time
      let stageDataForDiv = [];
      try {
        const relPath = divisionRelativeUrl || getRelativePath(divisionUrl);
        const stageUrl = relPath + (relPath.includes('?') ? '&' : '?') + 'group=stage';
        console.log(`Fetching stage data in same session for ${divisionName}: ${stageUrl}`);

        const stageNavPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null);
        const stageClicked = await page.evaluate((url) => {
          if (typeof window.submitRecaptcha !== "function") return { success: false };
          submitRecaptcha(url);
          return { success: true };
        }, stageUrl);

        if (stageClicked.success) {
          await stageNavPromise;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const stageHtml = await page.content();
          const $s = cheerio.load(stageHtml);
          const stageTables = $s('table');

          stageTables.each((idx, stageTable) => {
            const $stageTable = $s(stageTable);
            const stageRecords = parseHtmlTable($stageTable, $s);
            if (stageRecords.length === 0) return;

            let stageName = null;
            let el = $stageTable.prev();
            for (let i = 0; i < 5 && el.length; i++) {
              const tag = el.prop('tagName');
              if (tag && /^H[1-6]$/.test(tag)) { stageName = el.text().trim(); break; }
              el = el.prev();
            }
            if (!stageName) {
              el = $stageTable.parent().prev();
              for (let i = 0; i < 5 && el.length; i++) {
                const tag = el.prop('tagName');
                if (tag && /^H[1-6]$/.test(tag)) { stageName = el.text().trim(); break; }
                el = el.prev();
              }
            }
            if (!stageName) stageName = `Stage ${idx + 1}`;
            stageName = stageName.replace(/^.+?\s*-\s*/, '').trim();
            stageDataForDiv.push({ stageName, divisionName, records: stageRecords });
          });
          console.log(`Stage data for ${divisionName}: ${stageDataForDiv.length} stages`);
        }
      } catch (stageErr) {
        console.log(`Stage fetch in same session failed for ${divisionName}: ${stageErr.message}`);
      }

      // Calculate total time per shooter from stages
      const shooterTotalTime = {};
      for (const stage of stageDataForDiv) {
        const cols = Object.keys(stage.records[0] || {});
        const timeKey = cols.find(k => /^time$/i.test(k));
        const numKey = cols.find(k => k === '#') || cols.find(k => /^num|competitor/i.test(k));
        if (!timeKey || !numKey) continue;
        for (const rec of stage.records) {
          const sid = numKey ? String(rec[numKey]).trim() : null;
          if (!sid || !/^\d+$/.test(sid)) continue;
          const time = parseFloat(String(rec[timeKey] || '').replace(/[^0-9.\-]/g, '')) || 0;
          shooterTotalTime[sid] = (shooterTotalTime[sid] || 0) + time;
        }
      }
      // Inject Total Time into division records
      for (const record of records) {
        const sid = String(record['#'] || '').trim();
        if (sid && shooterTotalTime[sid] !== undefined) {
          record['Total Time'] = shooterTotalTime[sid].toFixed(2);
        } else {
          record['Total Time'] = '-';
        }
      }
      console.log(`Total Time injected for ${Object.keys(shooterTotalTime).length} shooters in ${divisionName}`);

      if (records.length) {
        return { records, shooterIds: Array.from(shooterIds), stageData: stageDataForDiv };
      }
    }

    return { records: [
      {
        division: divisionName,
        source_url: divisionUrl,
        note: "Kunde inte hitta divisionsresultat efter att ha laddat sidan.",
      },
    ], shooterIds: [] };
  } catch (error) {
    return { records: [
      {
        division: divisionName,
        source_url: divisionUrl,
        note: `Browserhämtning misslyckades: ${error.message}`,
      },
    ], shooterIds: [] };
  } finally {
    if (page) {
      await page.close();
    }
    await browser.close();
  }
};

// Fetch stage-by-stage results for a division using the ?group=stage view
// This gives us HF per shooter per stage - needed for true cross-division combined
const fetchDivisionStageData = async (matchUrl, divisionName, divisionUrl, divisionRelativeUrl) => {
  const browser = await launchBrowser();
  let page;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(matchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Navigate to stage view by appending ?group=stage to the division URL
    const relPath = divisionRelativeUrl || getRelativePath(divisionUrl);
    const stageUrl = relPath + (relPath.includes('?') ? '&' : '?') + 'group=stage';
    console.log(`Fetching stage data for ${divisionName}: ${stageUrl}`);

    const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null);
    const clicked = await page.evaluate((url) => {
      if (typeof window.submitRecaptcha !== "function") {
        return { success: false, error: "submitRecaptcha saknas" };
      }
      submitRecaptcha(url);
      return { success: true };
    }, stageUrl);

    if (!clicked.success) throw new Error(clicked.error);
    await navigationPromise;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Save debug HTML for first division
    const fs = require('fs');
    if (!fetchDivisionStageData._debugSaved) {
      fs.writeFileSync(path.join(__dirname, 'debug-stage-first.html'), html, 'utf8');
      fetchDivisionStageData._debugSaved = true;
      console.log(`Saved stage debug HTML for ${divisionName}`);
    }

    // Parse stage data - the page should have multiple tables, one per stage
    // Each stage has a heading (h2/h3/h4) followed by a table
    const stages = [];
    const tables = $('table');

    if (tables.length === 0) {
      console.log(`No stage tables found for ${divisionName}`);
      return [];
    }

    tables.each((idx, table) => {
      const $table = $(table);
      const records = parseHtmlTable($table, $);
      if (records.length === 0) return;

      // Try to find a stage name from a preceding heading
      let stageName = null;
      let el = $table.prev();
      for (let i = 0; i < 5 && el.length; i++) {
        const tag = el.prop('tagName');
        if (tag && /^H[1-6]$/.test(tag)) {
          stageName = el.text().trim();
          break;
        }
        el = el.prev();
      }
      // Also check parent's preceding siblings
      if (!stageName) {
        el = $table.parent().prev();
        for (let i = 0; i < 5 && el.length; i++) {
          const tag = el.prop('tagName');
          if (tag && /^H[1-6]$/.test(tag)) {
            stageName = el.text().trim();
            break;
          }
          el = el.prev();
        }
      }
      if (!stageName) stageName = `Stage ${idx + 1}`;

      // Normalize stage name: strip division prefix (e.g., "Production - Stage 01" -> "Stage 01")
      // This is critical so the same physical stage across divisions gets the same key
      // for cross-division HF comparison
      stageName = stageName.replace(/^.+?\s*-\s*/, '').trim();

      stages.push({ stageName, divisionName, records });
    });

    const totalRecords = stages.reduce((n, s) => n + s.records.length, 0);
    console.log(`Division ${divisionName}: ${stages.length} stages, ${totalRecords} shooter records`);

    if (stages.length > 0 && stages[0].records.length > 0) {
      const cols = Object.keys(stages[0].records[0]);
      console.log(`Stage columns: ${cols.join(', ')}`);
      console.log(`First record sample: ${JSON.stringify(stages[0].records[0])}`);
    }

    return stages;
  } catch (error) {
    console.log(`Stage fetch error for ${divisionName}: ${error.message}`);
    return [];
  } finally {
    if (page) await page.close();
    await browser.close();
  }
};

const fetchMatchData = async (url) => {
  const response = await axios.get(url, {
    headers: { "User-Agent": "ESSPortalReport/1.0" },
    timeout: 30000,
    responseEncoding: 'utf-8',
  });

  const contentType = response.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    const payload = response.data;
    if (Array.isArray(payload)) {
      return payload;
    }
    if (typeof payload === "object" && payload !== null) {
      return [payload];
    }
  }

  const $ = cheerio.load(response.data);
  const divisionLinks = extractDivisionLinks($, url);
  if (divisionLinks.length && !url.includes("/result/")) {
    let allRecords = [];
    for (const division of divisionLinks) {
      const divisionRecords = await fetchDivisionData(division.url, division.name);
      allRecords = allRecords.concat(divisionRecords);
    }
    return allRecords;
  }

  const table = $("table").first();
  if (table.length) {
    const records = parseHtmlTable(table, $);
    if (records.length) {
      return records;
    }
  }

  const dl = $("dl").first();
  if (dl.length) {
    const terms = dl.find("dt");
    const descs = dl.find("dd");
    const records = [];
    terms.each((index, term) => {
      const field = $(term).text().trim();
      const value = $(descs.get(index)).text().trim();
      records.push({ field, value });
    });
    if (records.length) {
      return records;
    }
  }

  const records = parseKeyValueList($, "p").concat(parseKeyValueList($, "li"));
  if (records.length) {
    return records;
  }

  return [
    { field: "title", value: $("title").text().trim() || url },
    { field: "url", value: url },
  ];
};

const preloadedResults = {};

// --- SQLite helper functions ---
const saveMatchToDb = (url, title, divisionData, stageData) => {
  const upsertMatch = db.prepare("INSERT INTO matches (url, title) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, fetched_at = datetime('now')");
  const deleteResults = db.prepare("DELETE FROM match_results WHERE match_id = ?");
  const insertResult = db.prepare("INSERT INTO match_results (match_id, view, data) VALUES (?, ?, ?)");
  const getMatch = db.prepare("SELECT id FROM matches WHERE url = ?");

  const transaction = db.transaction(() => {
    upsertMatch.run(url, title);
    const match = getMatch.get(url);
    deleteResults.run(match.id);
    if (divisionData) {
      for (const [viewName, records] of Object.entries(divisionData)) {
        insertResult.run(match.id, viewName, JSON.stringify(records));
      }
    }
    if (stageData && stageData.length > 0) {
      insertResult.run(match.id, "combined", JSON.stringify(stageData));
    }
  });
  transaction();
};

const loadMatchFromDb = (url) => {
  const match = db.prepare("SELECT id, title FROM matches WHERE url = ?").get(url);
  if (!match) return null;
  const rows = db.prepare("SELECT view, data FROM match_results WHERE match_id = ?").all(match.id);
  const data = {};
  let stageData = null;
  for (const row of rows) {
    if (row.view === "combined") {
      stageData = JSON.parse(row.data);
    } else {
      data[row.view] = JSON.parse(row.data);
    }
  }
  return { title: match.title, data, stageData };
};

const listSavedMatches = () => {
  return db.prepare("SELECT url, title, fetched_at FROM matches ORDER BY fetched_at DESC").all();
};

const filterOutSourceUrl = (records) => {
  return records.map((record) => {
    const filtered = { ...record };
    delete filtered.source_url;
    delete filtered.shooter_link;
    return filtered;
  });
};

const normalizeRecords = (records) => {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const firstRow = records[0];
  const firstRowValues = Object.values(firstRow).map((value) => String(value).trim());
  const headerValues = Object.keys(firstRow).map((key) => String(key).trim());

  if (
    firstRowValues.length === headerValues.length &&
    firstRowValues.every((value, index) => value === headerValues[index])
  ) {
    return records.slice(1);
  }

  return records;
};

const assignCombinedPlacement = (records) => {
  if (!Array.isArray(records) || records.length === 0) {
    return records;
  }

  // For combined: sort by Total Score (absolute points), NOT Score % (which is division-relative)
  const totalScoreKey = Object.keys(records[0]).find((key) => /^total\s*score$/i.test(key));
  const scoreKey = totalScoreKey ||
                   Object.keys(records[0]).find((key) => /total\s*score|total\s*points|match\s*points/i.test(key)) ||
                   Object.keys(records[0]).find((key) => /score\s*%|score|pom|points/i.test(key));
  if (!scoreKey) {
    return records;
  }

  console.log(`Combined ranking using column: "${scoreKey}"`);

  const ranked = records
    .map((record) => ({
      record,
      score: Number(String(record[scoreKey] || "").replace(/[^0-9.\-]/g, "")) || 0,
    }))
    .sort((a, b) => b.score - a.score || String(a.record.division || "").localeCompare(String(b.record.division || "")));

  // Find the highest total score across all divisions
  const maxScore = ranked.length > 0 ? ranked[0].score : 0;

  let rank = 0;
  let lastScore = null;
  ranked.forEach((entry, index) => {
    if (entry.score !== lastScore) {
      rank = index + 1;
      lastScore = entry.score;
    }
    entry.record["Overall Place"] = rank;
    // Recalculate Match % relative to the overall top scorer
    if (maxScore > 0) {
      entry.record["Match %"] = ((entry.score / maxScore) * 100).toFixed(2) + '%';
    }
  });

  return ranked.map((entry) => entry.record);
};

const summarizeRecords = (records) => {
  const filteredRecords = filterOutSourceUrl(records);
  const summary = {
    row_count: filteredRecords.length,
    columns: [],
    stats: {},
  };

  if (filteredRecords.length === 0) {
    return summary;
  }

  const columns = Object.keys(filteredRecords[0]);
  summary.columns = columns;

  columns.forEach((column) => {
    const values = filteredRecords.map((row) => row[column]);
    const numeric = values
      .map((value) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      })
      .filter((value) => value !== null);

    if (numeric.length) {
      summary.stats[column] = {
        count: numeric.length,
        mean: numeric.reduce((sum, value) => sum + value, 0) / numeric.length,
        min: Math.min(...numeric),
        max: Math.max(...numeric),
      };
    }
  });

  if (columns.includes("match_id")) {
    const uniqueMatches = new Set(filteredRecords.map((row) => row.match_id)).size;
    summary.unique_matches = uniqueMatches;
  }

  return summary;
};

// Calculate combined results from division stage data
// Uses hit factor (HF) per stage to rank all shooters across divisions
// allDivisionStages: [{stageName, divisionName, records: [{Place, #, Shooter, HF, ...}]}, ...]
const calculateCombinedFromStages = (allDivisionStages, shooterLookup) => {
  if (!allDivisionStages || allDivisionStages.length === 0) {
    console.log('No stage data available');
    return [];
  }

  // Identify the HF column from the first record
  const firstStage = allDivisionStages.find(s => s.records && s.records.length > 0);
  if (!firstStage) {
    console.log('No stage records found');
    return [];
  }

  const cols = Object.keys(firstStage.records[0]);
  console.log(`Stage record columns: ${cols.join(', ')}`);

  // Find key columns (case-insensitive)
  const hfKey = cols.find(k => /hit\s*factor|^hf$/i.test(k));
  const numKey = cols.find(k => k === '#') || cols.find(k => /^num|competitor/i.test(k));
  const nameKey = cols.find(k => /shooter|name|competitor/i.test(k) && k !== '#' && k !== 'shooter_link');
  const timeKey = cols.find(k => /^time$/i.test(k));
  const pointsKey = cols.find(k => /^points$/i.test(k));

  console.log(`Detected: HF=${hfKey}, #=${numKey}, name=${nameKey}, time=${timeKey}, points=${pointsKey}`);

  if (!hfKey && !timeKey) {
    console.log('Cannot find HF or time column for combined calculation');
    return [];
  }

  const parseNum = (v) => parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')) || 0;

  // Group by stage name: stageData[stageName][shooterId] = { hf, division }
  const stageData = {};
  const shooterDivisions = {}; // shooterId -> divisionName

  for (const stage of allDivisionStages) {
    const stageName = stage.stageName;
    if (!stageData[stageName]) stageData[stageName] = {};

    for (const record of stage.records) {
      const shooterId = numKey ? String(record[numKey]).trim() : null;
      if (!shooterId || !/^\d+$/.test(shooterId)) continue;

      let hf = hfKey ? parseNum(record[hfKey]) : 0;
      // Calculate HF from points/time if not directly available
      if (!hf && timeKey && pointsKey) {
        const time = parseNum(record[timeKey]);
        const points = parseNum(record[pointsKey]);
        if (time > 0) hf = points / time;
      }

      stageData[stageName][shooterId] = { hf };
      if (!shooterDivisions[shooterId]) {
        shooterDivisions[shooterId] = stage.divisionName;
      }

      // Build lookup if not already there
      if (!shooterLookup[shooterId] && nameKey) {
        shooterLookup[shooterId] = {
          name: record[nameKey] || '',
          division: stage.divisionName,
        };
      }
    }
  }

  const stageNames = Object.keys(stageData);
  const totalShooters = new Set(Object.values(stageData).flatMap(s => Object.keys(s))).size;
  console.log(`Combined: ${stageNames.length} stages, ${totalShooters} shooters across all divisions`);

  // For each stage, find the highest HF across ALL shooters (all divisions)
  // Then calculate match points: (shooterHF / maxHF) × 100 per stage
  const shooterMatchPoints = {};
  const shooterStageCount = {};

  for (const stageName of stageNames) {
    const entries = stageData[stageName];
    const maxHF = Math.max(...Object.values(entries).map(s => s.hf), 0);

    for (const [shooterId, data] of Object.entries(entries)) {
      if (!shooterMatchPoints[shooterId]) {
        shooterMatchPoints[shooterId] = 0;
        shooterStageCount[shooterId] = 0;
      }
      if (maxHF > 0 && data.hf > 0) {
        shooterMatchPoints[shooterId] += (data.hf / maxHF) * 100;
      }
      shooterStageCount[shooterId]++;
    }
  }

  const maxActual = Math.max(...Object.values(shooterMatchPoints), 0);

  // Sort and rank
  const ranked = Object.entries(shooterMatchPoints)
    .map(([shooterId, totalPts]) => ({
      shooterId,
      totalPts,
      matchPct: maxActual > 0 ? (totalPts / maxActual) * 100 : 0,
      lookup: shooterLookup[shooterId] || { name: `Shooter ${shooterId}`, division: shooterDivisions[shooterId] || '' },
      stageCount: shooterStageCount[shooterId] || 0,
    }))
    .sort((a, b) => b.totalPts - a.totalPts);

  let rank = 0, lastPts = null;
  const records = ranked.map((entry, index) => {
    if (entry.totalPts !== lastPts) {
      rank = index + 1;
      lastPts = entry.totalPts;
    }
    return {
      "Overall Place": rank,
      "#": entry.shooterId,
      "Shooter": entry.lookup.name,
      "Category": entry.lookup.category || '',
      "Class": entry.lookup.class || '',
      "Factor": entry.lookup.factor || '',
      "Division": entry.lookup.division,
      "Region": entry.lookup.region || '',
      "POM": entry.lookup.pom || '',
      "Total Time": entry.lookup.totalTime || '',
      "Match Pts": entry.totalPts.toFixed(2),
      "Match %": entry.matchPct.toFixed(2) + '%',
      "Stages": entry.stageCount,
    };
  });

  console.log(`Combined: ${records.length} shooters ranked across ${stageNames.length} stages`);
  if (records.length > 0) {
    console.log(`Top 3: ${records.slice(0, 3).map(r => `${r["Overall Place"]}. ${r.Shooter} (${r.Division}) ${r["Match %"]}`).join(', ')}`);
  }

  return records;
};

app.get("/", (req, res) => {
  res.render("index", {
    matchUrl: "",
    matchTitle: null,
    divisionLinks: null,
    selectedView: null,
    sectionTitle: null,
    error: null,
    records: null,
    summary: null,
    isPreloaded: false,
  });
});

app.post("/", async (req, res) => {
  const matchUrl = req.body.match_url ? req.body.match_url.trim() : "";
  if (!matchUrl) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: "Ange en matchlänk.", records: null, summary: null, isPreloaded: false });
  }
  if (!isUrl(matchUrl)) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: "Ogiltig URL.", records: null, summary: null, isPreloaded: false });
  }

  try {
    const overview = await fetchMatchOverview(matchUrl);
    console.log(`Preloading match: ${overview.title}`);
    preloadedResults[matchUrl] = { title: overview.title, divisionLinks: overview.divisionLinks, data: {}, shooterIds: [] };
    console.log(`Fetching ${overview.divisionLinks.length} divisions in parallel...`);
    const divisionResults = await Promise.all(
      overview.divisionLinks.map(async (division) => {
        console.log(`Fetching division: ${division.name}`);
        const { records, shooterIds, stageData } = await fetchDivisionData(matchUrl, division.name, division.url, division.relativeUrl);
        console.log(`Division ${division.name}: ${records.length} records, ${shooterIds.length} shooters`);
        return { name: division.name, records, shooterIds, stageData: stageData || [] };
      })
    );
    for (const result of divisionResults) {
      preloadedResults[matchUrl].data[result.name] = result.records;
      preloadedResults[matchUrl].shooterIds = preloadedResults[matchUrl].shooterIds.concat(result.shooterIds);
    }
    preloadedResults[matchUrl].shooterIds = [...new Set(preloadedResults[matchUrl].shooterIds)];
    console.log(`Total unique shooters: ${preloadedResults[matchUrl].shooterIds.length}`);

    // Cache stage data for combined calculation (from same browser sessions)
    preloadedResults[matchUrl].allStageResults = divisionResults.flatMap(r => r.stageData);

    // Auto-save to SQLite
    try {
      saveMatchToDb(matchUrl, overview.title, preloadedResults[matchUrl].data, null);
      console.log("Match saved to SQLite");
    } catch (e) {
      console.error("Failed to save to SQLite:", e.message);
    }

    return res.render("index", {
      matchUrl,
      matchTitle: overview.title,
      divisionLinks: overview.divisionLinks,
      selectedView: null,
      sectionTitle: null,
      error: null,
      records: null,
      summary: null,
      isPreloaded: true,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null, isPreloaded: false });
  }
});

app.get("/division", async (req, res) => {
  const matchUrl = req.query.matchUrl;
  const divisionUrl = req.query.divisionUrl;
  const divisionName = req.query.divisionName || "Division";

  if (!matchUrl || !divisionUrl || !isUrl(matchUrl) || !isUrl(divisionUrl)) {
    return res.redirect("/");
  }

  try {
    const overview = await fetchMatchOverview(matchUrl);
    let records = null;
    if (preloadedResults[matchUrl] && preloadedResults[matchUrl].data[divisionName]) {
      records = preloadedResults[matchUrl].data[divisionName];
    } else {
      const { records: fetchedRecords } = await fetchDivisionData(matchUrl, divisionName, divisionUrl);
      records = fetchedRecords;
    }
    records = normalizeRecords(records);
    const summary = summarizeRecords(records);
    const wasPreloaded = !!(preloadedResults[matchUrl] && preloadedResults[matchUrl].data[divisionName]);
    return res.render("index", {
      matchUrl,
      matchTitle: overview.title,
      divisionLinks: overview.divisionLinks,
      selectedView: "division",
      sectionTitle: divisionName,
      divisionUrl,
      error: null,
      records: filterOutSourceUrl(records),
      summary,
      isPreloaded: wasPreloaded,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null, isPreloaded: false });
  }
});

app.get("/combined", async (req, res) => {
  const matchUrl = req.query.matchUrl;
  if (!matchUrl || !isUrl(matchUrl)) {
    return res.redirect("/");
  }

  try {
    const overview = await fetchMatchOverview(matchUrl);
    console.log(`Loading combined for match: ${overview.title}`);
    let allRecords = [];

    // Check for cached stage-based combined data
    if (preloadedResults[matchUrl] && preloadedResults[matchUrl].stageData) {
      console.log(`Using cached stage-based combined data`);
      allRecords = preloadedResults[matchUrl].stageData;
    } else if (preloadedResults[matchUrl] && preloadedResults[matchUrl].allStageResults && preloadedResults[matchUrl].allStageResults.length > 0) {
      // Use cached stage data from preload to calculate combined
      console.log(`Using cached stage data from preload to calculate combined...`);
      const shooterLookup = {};
      if (preloadedResults[matchUrl].data) {
        for (const [divName, records] of Object.entries(preloadedResults[matchUrl].data)) {
          for (const record of records) {
            const numCol = record['#'];
            const nameKey = Object.keys(record).find((k) => /shooter|name|competitor/i.test(k) && k !== 'shooter_link');
            const id = numCol ? String(numCol).trim() : null;
            if (id && /^\d+$/.test(id)) {
              shooterLookup[id] = {
                name: nameKey ? record[nameKey] : '',
                division: record.division || divName,
                category: record['Category'] || '',
                class: record['Class'] || '',
                factor: record['Factor'] || '',
                region: record['Region'] || '',
                pom: record['POM'] || '',
                totalTime: record['Total Time'] || '',
              };
            }
          }
        }
      }
      allRecords = calculateCombinedFromStages(preloadedResults[matchUrl].allStageResults, shooterLookup);
      if (allRecords.length > 0) {
        preloadedResults[matchUrl].stageData = allRecords;
        try {
          saveMatchToDb(matchUrl, overview.title, preloadedResults[matchUrl].data, allRecords);
          console.log("Combined results saved to SQLite");
        } catch (e) {
          console.error("Failed to save combined to SQLite:", e.message);
        }
      }
    } else if (preloadedResults[matchUrl] && preloadedResults[matchUrl].divisionLinks && preloadedResults[matchUrl].divisionLinks.length > 0) {
      // Fetch stage data for each division (parallel, ~8 requests instead of 430 verify requests)
      const divisions = preloadedResults[matchUrl].divisionLinks;
      console.log(`Fetching stage data for ${divisions.length} divisions in parallel...`);

      // Build shooter lookup from preloaded division data
      const shooterLookup = {};
      if (preloadedResults[matchUrl].data) {
        for (const [divName, records] of Object.entries(preloadedResults[matchUrl].data)) {
          for (const record of records) {
            const numCol = record['#'];
            const nameKey = Object.keys(record).find((k) => /shooter|name|competitor/i.test(k) && k !== 'shooter_link');
            const id = numCol ? String(numCol).trim() : null;
            if (id && /^\d+$/.test(id)) {
              shooterLookup[id] = {
                name: nameKey ? record[nameKey] : '',
                division: record.division || divName,
                category: record['Category'] || '',
                class: record['Class'] || '',
                factor: record['Factor'] || '',
                region: record['Region'] || '',
                pom: record['POM'] || '',
                totalTime: record['Total Time'] || '',
              };
            }
          }
        }
      }
      console.log(`Shooter lookup: ${Object.keys(shooterLookup).length} entries`);

      // Reset debug flag
      fetchDivisionStageData._debugSaved = false;

      // Fetch stage view for each division in parallel
      const stageResults = await Promise.all(
        divisions.map(async (division) => {
          console.log(`Fetching stages for: ${division.name}`);
          const stages = await fetchDivisionStageData(matchUrl, division.name, division.url, division.relativeUrl);
          return stages;
        })
      );

      // Flatten all stage data
      const allDivisionStages = stageResults.flat();
      console.log(`Total stage data: ${allDivisionStages.length} stage-division entries`);

      // Calculate combined from stage HF data
      allRecords = calculateCombinedFromStages(allDivisionStages, shooterLookup);

      if (allRecords.length > 0) {
        console.log(`Combined calculated from stage HF data`);
        preloadedResults[matchUrl].stageData = allRecords;
        // Save combined to SQLite
        try {
          saveMatchToDb(matchUrl, overview.title, preloadedResults[matchUrl].data, allRecords);
          console.log("Combined results saved to SQLite");
        } catch (e) {
          console.error("Failed to save combined to SQLite:", e.message);
        }
      } else {
        console.log(`Stage data was empty, falling back to Total Score ranking`);
      }
    }

    // Fallback: rank by Total Score from division overview data
    if (allRecords.length === 0) {
      console.log(`Using fallback: ranking by Total Score from division data`);
      if (preloadedResults[matchUrl] && preloadedResults[matchUrl].data) {
        for (const division of overview.divisionLinks) {
          if (preloadedResults[matchUrl].data[division.name]) {
            allRecords = allRecords.concat(preloadedResults[matchUrl].data[division.name]);
          }
        }
      } else {
        for (const division of overview.divisionLinks) {
          const { records } = await fetchDivisionData(matchUrl, division.name, division.url, division.relativeUrl);
          allRecords = allRecords.concat(records);
        }
      }
      allRecords = normalizeRecords(allRecords);
      allRecords = assignCombinedPlacement(allRecords);
      allRecords = allRecords.map((record) => {
        const filtered = { ...record };
        delete filtered['Score %'];
        return filtered;
      });
    }
    const summary = summarizeRecords(allRecords);
    const wasPreloaded = !!(preloadedResults[matchUrl] && (preloadedResults[matchUrl].stageData || preloadedResults[matchUrl].data));
    return res.render("index", {
      matchUrl,
      matchTitle: overview.title,
      divisionLinks: overview.divisionLinks,
      selectedView: "combined",
      sectionTitle: "Combined",
      error: null,
      records: filterOutSourceUrl(allRecords),
      summary,
      isPreloaded: wasPreloaded,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null, isPreloaded: false });
  }
});

const port = process.env.PORT || 5000;

// --- CSV Export ---
app.get("/export/csv", (req, res) => {
  const matchUrl = req.query.matchUrl;
  const view = req.query.view; // "combined" or division name
  if (!matchUrl || !preloadedResults[matchUrl]) {
    return res.status(400).send("No data available. Load a match first.");
  }

  let records = [];
  let filename = "results";

  if (view === "combined" && preloadedResults[matchUrl].stageData) {
    records = preloadedResults[matchUrl].stageData;
    filename = "combined";
  } else if (preloadedResults[matchUrl].data && preloadedResults[matchUrl].data[view]) {
    records = filterOutSourceUrl(preloadedResults[matchUrl].data[view]);
    filename = view.replace(/\s+/g, '_').toLowerCase();
  } else {
    return res.status(404).send("No data for that view.");
  }

  if (records.length === 0) {
    return res.status(404).send("No records.");
  }

  const columns = Object.keys(records[0]);
  const escapeCsv = (val) => {
    const str = String(val == null ? '' : val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? '"' + str.replace(/"/g, '""') + '"'
      : str;
  };
  const csvLines = [columns.map(escapeCsv).join(',')];
  for (const row of records) {
    csvLines.push(columns.map(col => escapeCsv(row[col])).join(','));
  }

  const matchTitle = (preloadedResults[matchUrl].title || 'match').replace(/[^a-zA-Z0-9]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${matchTitle}_${filename}.csv"`);
  res.send('\uFEFF' + csvLines.join('\n'));
});

// --- Shooter Search ---
app.get("/search", (req, res) => {
  const matchUrl = req.query.matchUrl;
  const query = (req.query.q || '').trim().toLowerCase();

  if (!matchUrl || !preloadedResults[matchUrl] || !query) {
    return res.json([]);
  }

  const results = [];
  const data = preloadedResults[matchUrl].data || {};

  for (const [divName, records] of Object.entries(data)) {
    for (const record of records) {
      const nameKey = Object.keys(record).find(k => /shooter|name|competitor/i.test(k) && k !== 'shooter_link');
      const name = nameKey ? String(record[nameKey]).toLowerCase() : '';
      const num = record['#'] ? String(record['#']) : '';

      if (name.includes(query) || num === query) {
        results.push({
          '#': num,
          name: nameKey ? record[nameKey] : '',
          division: divName,
          place: record['Place'] || record['Overall Place'] || '',
          score: record['Score %'] || record['Total Score'] || '',
        });
      }
    }
  }

  // Also search combined if available
  if (preloadedResults[matchUrl].stageData) {
    for (const record of preloadedResults[matchUrl].stageData) {
      const name = String(record['Shooter'] || '').toLowerCase();
      const num = String(record['#'] || '');
      if (name.includes(query) || num === query) {
        const existing = results.find(r => r['#'] === num);
        if (existing) {
          existing.combinedPlace = record['Overall Place'];
          existing.matchPct = record['Match %'];
        }
      }
    }
  }

  res.json(results);
});

// --- PDF Export ---
app.get("/export/pdf", (req, res) => {
  const matchUrl = req.query.matchUrl;
  const view = req.query.view;
  if (!matchUrl || !preloadedResults[matchUrl]) {
    return res.status(400).send("No data available. Load a match first.");
  }

  let records = [];
  let filename = "results";
  const title = preloadedResults[matchUrl].title || "Match Results";

  if (view === "combined" && preloadedResults[matchUrl].stageData) {
    records = filterOutSourceUrl(preloadedResults[matchUrl].stageData);
    filename = "combined";
  } else if (preloadedResults[matchUrl].data && preloadedResults[matchUrl].data[view]) {
    records = filterOutSourceUrl(preloadedResults[matchUrl].data[view]);
    filename = view.replace(/\s+/g, "_").toLowerCase();
  } else {
    return res.status(404).send("No data for that view.");
  }

  if (records.length === 0) {
    return res.status(404).send("No records.");
  }

  const columns = Object.keys(records[0]);
  const matchTitleClean = title.replace(/[^a-zA-Z0-9 ]/g, "_");

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${matchTitleClean}_${filename}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(18).font("Helvetica-Bold").text(title, { align: "center" });
  doc.fontSize(11).font("Helvetica").text(view === "combined" ? "Combined Results" : view, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor("#666").text(`Generated: ${new Date().toLocaleString("sv-SE")}  |  ${records.length} competitors`, { align: "center" });
  doc.moveDown(1);

  // Table
  const maxCols = Math.min(columns.length, 12);
  const usedCols = columns.slice(0, maxCols);
  const tableLeft = 30;
  const tableWidth = 782; // A4 landscape - margins
  const colWidth = tableWidth / usedCols.length;
  const rowHeight = 16;
  let y = doc.y;

  // Header row
  doc.fillColor("#1a3a5c").rect(tableLeft, y, tableWidth, rowHeight).fill();
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7);
  usedCols.forEach((col, i) => {
    doc.text(col, tableLeft + i * colWidth + 3, y + 3, { width: colWidth - 6, lineBreak: false });
  });
  y += rowHeight;

  // Data rows
  doc.font("Helvetica").fontSize(7);
  for (let r = 0; r < records.length; r++) {
    if (y + rowHeight > doc.page.height - 30) {
      doc.addPage();
      y = 30;
      // Repeat header
      doc.fillColor("#1a3a5c").rect(tableLeft, y, tableWidth, rowHeight).fill();
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7);
      usedCols.forEach((col, i) => {
        doc.text(col, tableLeft + i * colWidth + 3, y + 3, { width: colWidth - 6, lineBreak: false });
      });
      y += rowHeight;
      doc.font("Helvetica").fontSize(7);
    }

    if (r % 2 === 0) {
      doc.fillColor("#f0f4f8").rect(tableLeft, y, tableWidth, rowHeight).fill();
    }
    doc.fillColor("#1a1a2e");
    usedCols.forEach((col, i) => {
      const val = String(records[r][col] == null ? "" : records[r][col]);
      doc.text(val, tableLeft + i * colWidth + 3, y + 3, { width: colWidth - 6, lineBreak: false });
    });
    y += rowHeight;
  }

  // Footer
  doc.moveDown(2);
  doc.fontSize(7).fillColor("#999").text("Neon Scoreboard — https://github.com/trbobubbla/neon-scoreboard", { align: "center" });

  doc.end();
});

// --- Match History (SQLite) ---
app.get("/history", (req, res) => {
  const matches = listSavedMatches();
  res.render("history", { matches });
});

app.get("/history/load", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.redirect("/history");

  const match = loadMatchFromDb(url);
  if (!match) return res.redirect("/?error=Match+not+found+in+database");

  // Restore to preloadedResults
  preloadedResults[url] = { title: match.title, divisionLinks: [], data: match.data, stageData: match.stageData, shooterIds: [] };

  // Try to get division links from overview
  try {
    const overview = await fetchMatchOverview(url);
    preloadedResults[url].divisionLinks = overview.divisionLinks;
  } catch (e) {
    // Build division links from saved data
    preloadedResults[url].divisionLinks = Object.keys(match.data).map((name) => ({ name, url: "", relativeUrl: "" }));
  }

  const divisionLinks = preloadedResults[url].divisionLinks;
  return res.render("index", {
    matchUrl: url,
    matchTitle: match.title,
    divisionLinks,
    selectedView: null,
    sectionTitle: null,
    error: null,
    records: null,
    summary: null,
    isPreloaded: true,
  });
});

const server = app.listen(port, () => {
  console.log(`ESSPortal web app körs på http://127.0.0.1:${port}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} är upptagen. Ange en annan port med PORT=<nummer> eller stoppa processen som använder porten.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
