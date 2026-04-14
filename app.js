const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));

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
    timeout: 15000,
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
      if (records.length) {
        return { records, shooterIds: Array.from(shooterIds) };
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

const fetchShooterVerify = async (matchUrl, shooterId, browser) => {
  console.log(`Starting fetchShooterVerify for shooter #${shooterId}`);
  let page;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to the match page (which contains the verify form)
    await page.goto(matchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for the verify form to be present
    await page.waitForSelector('#shooter', { timeout: 15000 });

    // Fill in the shooter number
    await page.type('#shooter', String(shooterId), { delay: 30 });

    // Click the GO button via submitRecaptcha (same pattern as division fetching)
    const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null);
    const submitted = await page.evaluate(() => {
      if (typeof window.submitRecaptcha !== "function") {
        return { success: false, error: "submitRecaptcha saknas på portal-sidan" };
      }
      submitRecaptcha(null, 'verify-form');
      return { success: true };
    });

    if (!submitted.success) {
      throw new Error(submitted.error);
    }

    await navigationPromise;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const html = await page.content();

    // Save debug HTML for first shooter only
    const fs = require('fs');
    if (!fetchShooterVerify._debugSaved) {
      fs.writeFileSync(path.join(__dirname, 'debug-verify-first.html'), html, 'utf8');
      fetchShooterVerify._debugSaved = true;
      console.log(`Saved first verify debug HTML`);
    }

    const $ = cheerio.load(html);

    // Parse ALL tables on the verify page
    const stages = [];
    const tables = $('table');

    tables.each((_, table) => {
      const rows = parseHtmlTable($(table), $);
      rows.forEach((row) => stages.push(row));
    });

    if (stages.length > 0 && !fetchShooterVerify._colsLogged) {
      console.log(`Verify stage columns: ${Object.keys(stages[0]).join(', ')}`);
      console.log(`First stage sample: ${JSON.stringify(stages[0])}`);
      fetchShooterVerify._colsLogged = true;
    }

    console.log(`  #${shooterId}: ${stages.length} stages`);
    return { shooterId, stages };
  } catch (error) {
    console.log(`  #${shooterId}: ERROR - ${error.message}`);
    return { shooterId, stages: [] };
  } finally {
    if (page) {
      await page.close();
    }
  }
};

const fetchMatchData = async (url) => {
  const response = await axios.get(url, {
    headers: { "User-Agent": "ESSPortalReport/1.0" },
    timeout: 15000,
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

// Calculate combined results from per-shooter verify stage data
// Uses hit factor (HF) per stage to rank all shooters across divisions
const calculateCombinedFromVerify = (allShooterData, shooterLookup) => {
  // allShooterData: [{shooterId, stages: [{stage columns...}, ...]}, ...]
  // First, we need to understand the stage columns from the data
  const validShooters = allShooterData.filter(s => s.stages && s.stages.length > 0);
  
  if (validShooters.length === 0) {
    console.log('No valid stage data from verify pages');
    return [];
  }

  const firstStage = validShooters[0].stages[0];
  const cols = Object.keys(firstStage);
  console.log(`Verify stage columns: ${cols.join(', ')}`);

  // Identify key columns (case-insensitive search)
  const hfKey = cols.find(k => /hit\s*factor|^hf$/i.test(k));
  const timeKey = cols.find(k => /^time$|stage\s*time/i.test(k));
  const pointsKey = cols.find(k => /^points$|stage\s*points|raw\s*points/i.test(k));
  const stageNameKey = cols.find(k => /^stage$|stage\s*name|^name$/i.test(k)) || cols.find(k => /stage/i.test(k));
  const matchPtsKey = cols.find(k => /match\s*p|stage\s*%|score/i.test(k));

  console.log(`Detected columns: HF=${hfKey}, time=${timeKey}, points=${pointsKey}, stage=${stageNameKey}, matchPts=${matchPtsKey}`);

  // Build per-shooter per-stage hit factors
  // stageData[stageName][shooterId] = { hf, time, points }
  const stageData = {};
  
  for (const shooter of validShooters) {
    for (const stage of shooter.stages) {
      const stageName = stageNameKey ? String(stage[stageNameKey]).trim() : `Stage`;
      if (!stageData[stageName]) stageData[stageName] = {};

      const parseNum = (v) => parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')) || 0;
      
      let hf = hfKey ? parseNum(stage[hfKey]) : 0;
      const time = timeKey ? parseNum(stage[timeKey]) : 0;
      const points = pointsKey ? parseNum(stage[pointsKey]) : 0;

      // Calculate HF if not directly available
      if (!hf && time > 0 && points > 0) {
        hf = points / time;
      }

      stageData[stageName][shooter.shooterId] = { hf, time, points };
    }
  }

  const stageNames = Object.keys(stageData);
  console.log(`Found ${stageNames.length} stages: ${stageNames.join(', ')}`);

  // For each stage, find the highest HF across ALL shooters (all divisions)
  // Then calculate stage match points: (shooterHF / stageMaxHF) * maxStagePoints
  // IPSC uses variable max stage points (number of scoring hits * 5), but for ranking
  // we can use a fixed max (like 100) since it's proportional
  const MAX_STAGE_POINTS = 100;

  // Calculate match points per shooter
  const shooterMatchPoints = {};
  
  for (const stageName of stageNames) {
    const stageShooters = stageData[stageName];
    const maxHF = Math.max(...Object.values(stageShooters).map(s => s.hf));
    
    for (const [shooterId, data] of Object.entries(stageShooters)) {
      if (!shooterMatchPoints[shooterId]) shooterMatchPoints[shooterId] = 0;
      if (maxHF > 0 && data.hf > 0) {
        shooterMatchPoints[shooterId] += (data.hf / maxHF) * MAX_STAGE_POINTS;
      }
    }
  }

  // Maximum possible = stageCount * MAX_STAGE_POINTS
  const maxPossible = stageNames.length * MAX_STAGE_POINTS;
  const maxActual = Math.max(...Object.values(shooterMatchPoints));

  // Sort shooters by total match points
  const ranked = Object.entries(shooterMatchPoints)
    .map(([shooterId, totalPts]) => ({
      shooterId,
      totalPts,
      matchPct: maxActual > 0 ? (totalPts / maxActual) * 100 : 0,
      lookup: shooterLookup[shooterId] || { name: `Shooter ${shooterId}`, division: '' },
      stageCount: validShooters.find(s => s.shooterId === shooterId)?.stages.length || 0,
    }))
    .sort((a, b) => b.totalPts - a.totalPts);

  // Assign placement
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
      "Division": entry.lookup.division,
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
        const { records, shooterIds } = await fetchDivisionData(matchUrl, division.name, division.url, division.relativeUrl);
        console.log(`Division ${division.name}: ${records.length} records, ${shooterIds.length} shooters`);
        return { name: division.name, records, shooterIds };
      })
    );
    for (const result of divisionResults) {
      preloadedResults[matchUrl].data[result.name] = result.records;
      preloadedResults[matchUrl].shooterIds = preloadedResults[matchUrl].shooterIds.concat(result.shooterIds);
    }
    preloadedResults[matchUrl].shooterIds = [...new Set(preloadedResults[matchUrl].shooterIds)];
    console.log(`Total unique shooters: ${preloadedResults[matchUrl].shooterIds.length}`);
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
    if (preloadedResults[matchUrl] && preloadedResults[matchUrl].verifyData) {
      console.log(`Using cached combined verify data`);
      allRecords = preloadedResults[matchUrl].verifyData;
    } else if (preloadedResults[matchUrl] && preloadedResults[matchUrl].shooterIds && preloadedResults[matchUrl].shooterIds.length > 0) {
      const shooterIds = preloadedResults[matchUrl].shooterIds;
      console.log(`Fetching verify data for ${shooterIds.length} shooters to calculate true combined`);

      // Build a lookup from preloaded division data: shooterId -> {name, division}
      const shooterLookup = {};
      if (preloadedResults[matchUrl].data) {
        for (const [divName, records] of Object.entries(preloadedResults[matchUrl].data)) {
          for (const record of records) {
            // Use the # column for lookup
            const numCol = record['#'];
            const nameKey = Object.keys(record).find((k) => /shooter|name|competitor/i.test(k) && k !== 'shooter_link');
            const id = numCol ? String(numCol).trim() : null;
            if (id && /^\d+$/.test(id)) {
              shooterLookup[id] = {
                name: nameKey ? record[nameKey] : '',
                division: record.division || divName,
              };
            }
            // Also try from shooter_link
            if (record.shooter_link) {
              const m = record.shooter_link.match(/\/shooter\/(\d+)/);
              if (m && !shooterLookup[m[1]]) {
                shooterLookup[m[1]] = {
                  name: nameKey ? record[nameKey] : '',
                  division: record.division || divName,
                };
              }
            }
          }
        }
      }
      console.log(`Built shooter lookup with ${Object.keys(shooterLookup).length} entries`);

      // Launch ONE shared browser for all verify fetches
      const browser = await launchBrowser();
      fetchShooterVerify._debugSaved = false;
      fetchShooterVerify._colsLogged = false;

      try {
        // Fetch verify data with concurrency limit of 5 (parallel tabs)
        const concurrency = 5;
        const allShooterData = [];
        for (let i = 0; i < shooterIds.length; i += concurrency) {
          const batch = shooterIds.slice(i, i + concurrency);
          console.log(`Verify batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(shooterIds.length / concurrency)} (${batch.length} shooters): ${batch.join(', ')}`);
          const results = await Promise.all(
            batch.map((id) => fetchShooterVerify(matchUrl, id, browser))
          );
          allShooterData.push(...results);
          console.log(`  Progress: ${Math.min(i + concurrency, shooterIds.length)}/${shooterIds.length} done`);
        }

        // Calculate true combined from raw stage HF data
        allRecords = calculateCombinedFromVerify(allShooterData, shooterLookup);
      } finally {
        await browser.close();
      }

      if (allRecords.length > 0) {
        console.log(`Combined calculated from verify stage data`);
        preloadedResults[matchUrl].verifyData = allRecords;
      } else {
        console.log(`Verify data was empty, falling back to division aggregation`);
        // Fallback
        if (preloadedResults[matchUrl] && preloadedResults[matchUrl].data) {
          for (const division of overview.divisionLinks) {
            if (preloadedResults[matchUrl].data[division.name]) {
              allRecords = allRecords.concat(preloadedResults[matchUrl].data[division.name]);
            }
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
    } else {
      // Fallback to aggregating divisions
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
      // Remove division-relative Score % since we now have overall Match %
      allRecords = allRecords.map((record) => {
        const filtered = { ...record };
        delete filtered['Score %'];
        return filtered;
      });
    }
    const summary = summarizeRecords(allRecords);
    const wasPreloaded = !!(preloadedResults[matchUrl] && (preloadedResults[matchUrl].verifyData || preloadedResults[matchUrl].data));
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
