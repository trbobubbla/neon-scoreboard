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
    const text = cheerio(node).text().trim();
    const parts = text.split(":");
    if (parts.length >= 2) {
      const field = parts.shift().trim();
      records.push({ field, value: parts.join(":").trim() });
    }
  });
  return records;
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
  res.render("index", { matchUrl: "", error: null, records: null, summary: null });
});

app.post("/", async (req, res) => {
  const matchUrl = req.body.match_url ? req.body.match_url.trim() : "";
  if (!matchUrl) {
    return res.render("index", { matchUrl, error: "Ange en matchlänk.", records: null, summary: null });
  }
  if (!isUrl(matchUrl)) {
    return res.render("index", { matchUrl, error: "Ogiltig URL.", records: null, summary: null });
  }

  try {
    const records = await fetchMatchData(matchUrl);
    const summary = summarizeRecords(records);
    return res.render("index", { matchUrl, error: null, records, summary });
  } catch (error) {
    return res.render("index", { matchUrl, error: error.message, records: null, summary: null });
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
