const cheerio = require('cheerio');
const fs = require('fs');

// Check division debug HTML
if (fs.existsSync('debug-division-first.html')) {
  const html = fs.readFileSync('debug-division-first.html', 'utf8');
  const $ = cheerio.load(html);
  const table = $('table').first();
  const headers = [];
  table.find('tr').first().find('th').each((i, th) => headers.push($(th).text().trim()));
  console.log('Division headers:', headers);
  
  // First 2 data rows
  table.find('tr').slice(1, 3).each((i, tr) => {
    const cells = [];
    $(tr).find('td').each((j, td) => cells.push($(td).text().trim()));
    console.log(`Division row ${i}:`, cells);
  });
}

// Check stage debug HTML
if (fs.existsSync('debug-stage-first.html')) {
  const html = fs.readFileSync('debug-stage-first.html', 'utf8');
  const $ = cheerio.load(html);
  const tables = $('table');
  console.log(`\nStage tables found: ${tables.length}`);
  
  const firstTable = tables.first();
  const headers = [];
  firstTable.find('tr').first().find('th').each((i, th) => headers.push($(th).text().trim()));
  console.log('Stage headers:', headers);
  
  firstTable.find('tr').slice(1, 3).each((i, tr) => {
    const cells = [];
    $(tr).find('td').each((j, td) => cells.push($(td).text().trim()));
    console.log(`Stage row ${i}:`, cells);
  });
}
