import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landmodo.com';

const STATE_NAMES = {
  'oklahoma': 'Oklahoma',
  'missouri': 'Missouri',
  'arkansas': 'Arkansas',
  'texas': 'Texas',
  'kansas': 'Kansas',
  'tennessee': 'Tennessee',
  'kentucky': 'Kentucky',
  'illinois': 'Illinois',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

export async function scrapeLandmodo({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const stateName = STATE_NAMES[state.toLowerCase()];
    if (!stateName) continue;

    // Try multiple URL patterns since Landmodo's URLs change
    const urlsToTry = [
      `${BASE_URL}/land-for-sale/${state.toLowerCase()}`,
      `${BASE_URL}/properties/${state.toLowerCase()}`,
      `${BASE_URL}/state/${state.toLowerCase()}`,
      `${BASE_URL}/land/${state.toLowerCase()}`,
      `${BASE_URL}/?state=${stateName}`,
    ];

    let html = null;
    let successUrl = null;

    for (const url of urlsToTry) {
      console.log(`  [Landmodo] Trying ${url}`);
      try {
        const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (response.ok) {
          const text = await response.text();
          // Check if it's a real page with property data (not a 404 page)
          if (!text.includes("can't find this page") && !text.includes('new404') && text.includes('properties')) {
            html = text;
            successUrl = url;
            console.log(`  [Landmodo] Success with ${url}`);
            break;
          }
        }
      } catch (err) {
        // Try next URL
      }
    }

    // Also try the main page which lists recent properties
    if (!html) {
      console.log(`  [Landmodo] Trying main page`);
      try {
        const response = await fetch(BASE_URL, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (response.ok) {
          html = await response.text();
          successUrl = BASE_URL;
          console.log(`  [Landmodo] Using main page`);
        }
      } catch (err) {
        console.error(`  [Landmodo] Main page failed:`, err.message);
      }
    }

    if (!html) {
      console.log(`  [Landmodo] No working URL found for ${state}`);
      continue;
    }

    const $ = cheerio.load(html);

    // Find all property links with IDs in URL
    const propertyLinks = new Map();

    $('a[href*="/properties/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/properties\/(\d{4,})\//);
      if (!match) return;

      const propId = match[1];
      if (propertyLinks.has(propId)) return;

      const title = $(el).text().trim();
      if (!title || title === 'View More' || title.length < 5) return;

      // Filter by state name in title/URL if we're on the main page
      if (successUrl === BASE_URL) {
        const hrefLower = href.toLowerCase();
        const titleLower = title.toLowerCase();
        if (!hrefLower.includes(state.toLowerCase()) && !hrefLower.includes('-ok-') &&
            !titleLower.includes(stateName.toLowerCase()) && !titleLower.includes(', ok')) {
          return;
        }
      }

      const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
      propertyLinks.set(propId, { title, url: fullUrl, propId });
    });

    // Find prices near property links
    const priceMap = new Map();
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (/^\$[\d,]+(\.\d{2})?$/.test(text)) {
        let parent = $(el);
        for (let i = 0; i < 10; i++) {
          parent = parent.parent();
          const link = parent.find('a[href*="/properties/"]').first();
          if (link.length) {
            const href = link.attr('href') || '';
            const m = href.match(/\/properties\/(\d{4,})\//);
            if (m && !priceMap.has(m[1])) {
              priceMap.set(m[1], parseFloat(text.replace(/[$,]/g, '')));
            }
            break;
          }
        }
      }
    });

    // Combine property data
    for (const [propId, prop] of propertyLinks) {
      const price = priceMap.get(propId) || null;

      const acresMatch = prop.title.match(/([\d.]+)\s*(?:-?\s*)?Acres?/i) ||
                         prop.title.match(/([\d.]+)\s*(?:-?\s*)?acre/i);
      const acres = acresMatch ? parseFloat(acresMatch[1]) : null;

      const locMatch = prop.title.match(/,\s*([A-Za-z\s.]+),\s*OK\s*(\d+)/);
      const countyInTitle = prop.title.match(/([A-Za-z]+)\s*County/i);
      const county = countyInTitle ? countyInTitle[1] : (locMatch ? locMatch[1].trim() : null);
      const zip = locMatch ? locMatch[2] : (prop.title.match(/\b(\d{5})\b/) || [])[1] || '';

      // Apply filters
      if (price !== null) {
        if (price > maxPrice || price < (minPrice || 0)) continue;
      }
      if (acres !== null) {
        if (minAcres > 0 && acres < minAcres) continue;
        if (maxAcres < 1000 && acres > maxAcres) continue;
      }
      if (counties && counties.length > 0 && county) {
        const countyLower = county.toLowerCase();
        if (!counties.some(c => c.toLowerCase() === countyLower)) continue;
      }

      results.push({
        id: `landmodo-${propId}`,
        title: prop.title,
        price,
        acres,
        county: county || 'Unknown',
        state,
        zip: zip || '',
        listingUrl: prop.url,
        source: 'Landmodo',
        ownerFinancing: true,
        description: prop.title,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}
