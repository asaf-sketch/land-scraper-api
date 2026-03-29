import express from 'express';
import cors from 'cors';
import { scrapeLandmodo } from './scrapers/landmodo.js';
import { scrapeLandwatch } from './scrapers/landwatch.js';
import { scrapeLandsearch } from './scrapers/landsearch.js';
import { scrapeLandflip } from './scrapers/landflip.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check — multiple paths for compatibility
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AADreamland Land Scraper API',
    version: '2.0.0',
    uptime: process.uptime(),
    scrapers: ['LandWatch', 'Landmodo', 'LandSearch', 'LandFlip'],
    endpoints: {
      search: 'POST /api/search',
      searchStream: 'GET /api/search/stream',
      health: 'GET /health',
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    scrapers: ['LandWatch', 'Landmodo', 'LandSearch', 'LandFlip'],
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const { states, counties, maxPrice, minPrice, minAcres, maxAcres, ownerFinancing } = req.body;

  if (!states || states.length === 0) {
    return res.status(400).json({ error: 'At least one state is required' });
  }

  console.log(`[SEARCH] Starting search: states=${states.join(',')}, maxPrice=${maxPrice}, minAcres=${minAcres}`);

  const allResults = [];
  const progress = [];
  const errors = [];

  // Define scrapers to run
  const scrapers = [
    { name: 'Landmodo', fn: scrapeLandmodo },
    { name: 'LandWatch', fn: scrapeLandwatch },
    { name: 'LandSearch', fn: scrapeLandsearch },
    { name: 'LandFlip', fn: scrapeLandflip },
  ];

  for (const scraper of scrapers) {
    const start = Date.now();
    try {
      console.log(`[SEARCH] Scraping ${scraper.name}...`);
      const results = await scraper.fn({
        states,
        counties: counties || [],
        maxPrice: maxPrice || 50000,
        minPrice: minPrice || 0,
        minAcres: minAcres || 0,
        maxAcres: maxAcres || 1000,
        ownerFinancing: ownerFinancing || false,
      });
      const elapsed = Date.now() - start;
      console.log(`[SEARCH] ${scraper.name}: found ${results.length} properties in ${elapsed}ms`);
      allResults.push(...results);
      progress.push({ site: scraper.name, found: results.length, timeMs: elapsed, status: 'ok' });
    } catch (err) {
      const elapsed = Date.now() - start;
      console.error(`[SEARCH] ${scraper.name} error:`, err.message);
      errors.push({ site: scraper.name, error: err.message });
      progress.push({ site: scraper.name, found: 0, timeMs: elapsed, status: 'error', error: err.message });
    }
  }

  // Deduplicate by listing URL
  const seen = new Set();
  const unique = allResults.filter(p => {
    const key = p.listingUrl.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by price ascending
  unique.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  console.log(`[SEARCH] Done. ${unique.length} unique results from ${scrapers.length} sites`);

  res.json({
    results: unique,
    meta: {
      totalResults: unique.length,
      sitesSearched: progress,
      errors,
      searchCriteria: { states, counties, maxPrice, minPrice, minAcres, maxAcres, ownerFinancing },
      timestamp: new Date().toISOString(),
    }
  });
});

// GET search endpoint (JSON) — for simple queries
app.get('/api/search', async (req, res) => {
  const { states: rawStates, counties: rawCounties, maxPrice, minAcres, maxAcres, ownerFinancing } = req.query;
  const stateList = rawStates ? (Array.isArray(rawStates) ? rawStates : rawStates.split(',')) : [];
  const countyList = rawCounties ? (Array.isArray(rawCounties) ? rawCounties : rawCounties.split(',')) : [];

  if (stateList.length === 0) {
    return res.status(400).json({ error: 'states parameter required' });
  }

  const criteria = {
    states: stateList,
    counties: countyList,
    maxPrice: parseInt(maxPrice) || 50000,
    minPrice: 0,
    minAcres: parseFloat(minAcres) || 0,
    maxAcres: parseFloat(maxAcres) || 1000,
    ownerFinancing: ownerFinancing === 'true',
  };

  console.log(`[SEARCH GET] states=${stateList.join(',')}, maxPrice=${maxPrice}`);
  const allResults = [];
  const scraperList = [
    { name: 'LandWatch', fn: scrapeLandwatch },
    { name: 'Landmodo', fn: scrapeLandmodo },
    { name: 'LandSearch', fn: scrapeLandsearch },
    { name: 'LandFlip', fn: scrapeLandflip },
  ];

  for (const s of scraperList) {
    try {
      const results = await s.fn(criteria);
      allResults.push(...results);
      console.log(`[SEARCH GET] ${s.name}: ${results.length} results`);
    } catch (err) {
      console.error(`[SEARCH GET] ${s.name} error:`, err.message);
    }
  }

  const seen = new Set();
  const unique = allResults.filter(p => {
    const key = (p.listingUrl || p.title || '').toLowerCase().substring(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  res.json({ results: unique, totalResults: unique.length });
});

// Streaming search endpoint (Server-Sent Events for real-time progress)
app.get('/api/search/stream', async (req, res) => {
  const { states, maxPrice, minAcres, maxAcres, counties, ownerFinancing } = req.query;

  if (!states) {
    return res.status(400).json({ error: 'states parameter required' });
  }

  const stateList = states.split(',');
  const countyList = counties ? counties.split(',') : [];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const scrapers = [
    { name: 'Landmodo', fn: scrapeLandmodo },
    { name: 'LandWatch', fn: scrapeLandwatch },
    { name: 'LandSearch', fn: scrapeLandsearch },
    { name: 'LandFlip', fn: scrapeLandflip },
  ];

  const allResults = [];
  sendEvent('start', { totalSites: scrapers.length, sites: scrapers.map(s => s.name) });

  for (let i = 0; i < scrapers.length; i++) {
    const scraper = scrapers[i];
    sendEvent('progress', {
      site: scraper.name,
      index: i,
      total: scrapers.length,
      percent: Math.round((i / scrapers.length) * 100)
    });

    try {
      const results = await scraper.fn({
        states: stateList,
        counties: countyList,
        maxPrice: parseInt(maxPrice) || 50000,
        minPrice: 0,
        minAcres: parseFloat(minAcres) || 0,
        maxAcres: parseFloat(maxAcres) || 1000,
        ownerFinancing: ownerFinancing === 'true',
      });
      allResults.push(...results);
      sendEvent('site_done', { site: scraper.name, found: results.length });
    } catch (err) {
      sendEvent('site_error', { site: scraper.name, error: err.message });
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = allResults.filter(p => {
    const key = p.listingUrl.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  sendEvent('done', { results: unique, totalResults: unique.length });
  res.end();
});

app.listen(PORT, () => {
  console.log(`Land Scraper API running on port ${PORT}`);
});
