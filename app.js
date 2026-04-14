const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

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
    cells.each((_, cell) => values.push($(cell).text().trim()));

    if (headers.length === values.length) {
      const record = {};
      headers.forEach((header, index) => {
        record[header || `column_${index + 1}`] = values[index] || "";
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

const extractDivisionLinks = ($, baseUrl) => {
  const links = [];
  $(".list-group-item").each((_, node) => {
    const href = $(node).attr("onclick") || "";
    const match = href.match(/submitRecaptcha\(['"]([^'"]+)['"]/);
    if (match) {
      const divisionName = $(node).text().trim();
      try {
        links.push({
          name: divisionName,
          url: new URL(match[1], baseUrl).toString(),
        });
      } catch (_) {
        links.push({ name: divisionName, url: match[1] });
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
  return { title, divisionLinks };
};

const fetchDivisionData = async (url, divisionName) => {
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": "ESSPortalReport/1.0" },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const $ = cheerio.load(response.data);
    const table = $("table").first();
    if (table.length) {
      const records = parseHtmlTable(table, $).map((record) => ({
        division: divisionName,
        source_url: url,
        ...record,
      }));
      if (records.length) {
        return records;
      }
    }

    const hasCaptcha = $("#captcha-form").length > 0 || $("input[name='g-recaptcha-response']").length > 0;
    if (hasCaptcha) {
      return [
        {
          division: divisionName,
          source_url: url,
          note: "Resultat är blockerade av reCAPTCHA och kan inte hämtas automatiskt.",
        },
      ];
    }
  } catch (error) {
    return [
      {
        division: divisionName,
        source_url: url,
        note: `Kunde inte hämta divisionen: ${error.message}`,
      },
    ];
  }

  return [
    {
      division: divisionName,
      source_url: url,
      note: "Ingen tabell hittades på divisionsresultatsidan.",
    },
  ];
};

const fetchCombinedResults = async (matchUrl) => {
  const overview = await fetchMatchOverview(matchUrl);
  let allRecords = [];
  for (const division of overview.divisionLinks) {
    const records = await fetchDivisionData(division.url, division.name);
    allRecords = allRecords.concat(records);
  }
  return { title: overview.title, divisionLinks: overview.divisionLinks, records: allRecords };
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

const summarizeRecords = (records) => {
  const summary = {
    row_count: records.length,
    columns: [],
    stats: {},
  };

  if (records.length === 0) {
    return summary;
  }

  const columns = Object.keys(records[0]);
  summary.columns = columns;

  columns.forEach((column) => {
    const values = records.map((row) => row[column]);
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
    const uniqueMatches = new Set(records.map((row) => row.match_id)).size;
    summary.unique_matches = uniqueMatches;
  }

  return summary;
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
  });
});

app.post("/", async (req, res) => {
  const matchUrl = req.body.match_url ? req.body.match_url.trim() : "";
  if (!matchUrl) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: "Ange en matchlänk.", records: null, summary: null });
  }
  if (!isUrl(matchUrl)) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: "Ogiltig URL.", records: null, summary: null });
  }

  try {
    const overview = await fetchMatchOverview(matchUrl);
    return res.render("index", {
      matchUrl,
      matchTitle: overview.title,
      divisionLinks: overview.divisionLinks,
      selectedView: null,
      sectionTitle: null,
      error: null,
      records: null,
      summary: null,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null });
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
    const records = await fetchDivisionData(divisionUrl, divisionName);
    const summary = summarizeRecords(records);
    return res.render("index", {
      matchUrl,
      matchTitle: overview.title,
      divisionLinks: overview.divisionLinks,
      selectedView: "division",
      sectionTitle: divisionName,
      error: null,
      records,
      summary,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null });
  }
});

app.get("/combined", async (req, res) => {
  const matchUrl = req.query.matchUrl;
  if (!matchUrl || !isUrl(matchUrl)) {
    return res.redirect("/");
  }

  try {
    const combined = await fetchCombinedResults(matchUrl);
    const summary = summarizeRecords(combined.records);
    return res.render("index", {
      matchUrl,
      matchTitle: combined.title,
      divisionLinks: combined.divisionLinks,
      selectedView: "combined",
      sectionTitle: "Combined",
      error: null,
      records: combined.records,
      summary,
    });
  } catch (error) {
    return res.render("index", { matchUrl, matchTitle: null, divisionLinks: null, selectedView: null, sectionTitle: null, error: error.message, records: null, summary: null });
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
