import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landflip.com';

const STATE_SLUGS = {
  'oklahoma': 'oklahoma',
  'missouri': 'missouri',
  'arkansas': 'arkansas',
  'texas': 'texas',
  'kansas': 'kansas',
  'tennessee': 'tennessee',
  'kentucky': 'kentucky',
  'illinois': 'illinois',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
};

function buildUrl(state, county, minAcres, maxPrice) {
  const stateSlug = state.toLowerCase().replace(/\s+/g, '-');
  let url = `${BASE_URL}/land-for-sale/${stateSlug}`;

  if (minAcres && maxPrice) {
    url += `/${minAcres}-minacres/${maxPrice}-maxprice`;
  } else if (county) {
    url += `/${county.toLowerCase()}-county`;
  }

  return url;
}

async function fetchWithRetry(url, maxRetries = 1) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000)
      });

      if (response.status === 403 && attempt < maxRetries) {
        // Retry with base URL without filters
        const baseUrl = url.split('/land-for-sale/')[0] + '/land-for-sale/' + url.split('/land-for-sale/')[1].split('/')[0];
        console.log(`  [LandFlip] Got 403, retrying with base URL: ${baseUrl}`);
        url = baseUrl;
        lastError = `HTTP ${response.status}`;
        continue;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        throw new Error(`HTTP ${response.status}`);
      }

      return response;
    } catch (err) {
      lastError = err.message;
      if (attempt === maxRetries) {
        throw err;
      }
    }
  }

  throw new Error(lastError);
}

function parsePrice(text) {
  const match = text.match(/\$([\d,]+)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function parseAcres(text) {
  const match = text.match(/([\d.]+)\s*(?:acres?|ac)/i);
  return match ? parseFloat(match[1]) : null;
}

function parseCounty(text) {
  const match = text.match(/([A-Za-z\s]+)\s*County/i);
  return match ? match[1].trim() : null;
}

function extractPid(url) {
  // Look for /pid/XXXXX or numeric IDs with 5+ digits
  const pidMatch = url.match(/\/pid\/(\d+)/);
  if (pidMatch) return pidMatch[1];

  const numMatch = url.match(/\/(\d{5,})/);
  if (numMatch) return numMatch[1];

  return null;
}

function isValidListingUrl(href) {
  // Accept URLs with /pid/ or numeric IDs (5+ digits)
  return href.match(/\/pid\/\d+/) || href.match(/\/\d{5,}/);
}

export async function scrapeLandflip({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];
  const seen = new Set();

  for (const state of states) {
    const stateSlug = STATE_SLUGS[state.toLowerCase()];
    if (!stateSlug) continue;

    // Build URLs with filter segments if available
    const urls = [];

    if (minAcres && maxPrice) {
      urls.push(buildUrl(state, null, minAcres, maxPrice));
    } else if (counties && counties.length > 0) {
      for (const county of counties) {
        urls.push(buildUrl(state, county, null, null));
      }
    } else {
      urls.push(buildUrl(state, null, null, null));
    }

    for (const url of urls) {
      console.log(`  [LandFlip] Fetching ${url}`);

      try {
        const response = await fetchWithRetry(url);
        const html = await response.text();
        const $ = cheerio.load(html);

        // Parse JSON-LD first
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const data = JSON.parse($(el).html());
            const listings = Array.isArray(data) ? data : data.itemListElement ? data.itemListElement : [data];

            for (const item of listings) {
              const listing = item.item || item;
              if (!listing.name || !listing.url) continue;

              const pid = extractPid(listing.url);
              if (!pid) continue;

              const price = listing.offers?.price || 0;
              const acresMatch = listing.name.match(/([\d.]+)\s*(?:acres?|ac)/i);
              const countyMatch = listing.name.match(/([A-Za-z]+)\s*County/i);

              if (maxPrice && price > maxPrice) continue;
              if (minPrice && price < minPrice) continue;
              if (minAcres && acresMatch && parseFloat(acresMatch[1]) < minAcres) continue;
              if (maxAcres && acresMatch && parseFloat(acresMatch[1]) > maxAcres) continue;

              const fullUrl = listing.url.startsWith('http') ? listing.url : BASE_URL + listing.url;
              if (seen.has(fullUrl)) continue;
              seen.add(fullUrl);

              results.push({
                id: `lf-${pid}`,
                title: listing.name,
                price: parseFloat(price) || 0,
                acres: acresMatch ? parseFloat(acresMatch[1]) : null,
                county: countyMatch ? countyMatch[1] : null,
                state,
                zip: '',
                listingUrl: fullUrl,
                source: 'LandFlip',
                ownerFinancing: (listing.description || '').toLowerCase().includes('owner financ'),
                description: listing.description?.substring(0, 500) || listing.name,
                scrapedAt: new Date().toISOString().split('T')[0],
              });
            }
          } catch {}
        });

        // Fallback to HTML cards
        $('a').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!isValidListingUrl(href)) return;

          const title = $(el).text().trim();
          if (!title || title.length < 5) return;

          const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
          if (seen.has(fullUrl)) return;
          seen.add(fullUrl);

          const pid = extractPid(href);
          if (!pid) return;

          const container = $(el).closest('div, article');
          const containerText = container.text() || '';

          const price = parsePrice(containerText) || 0;
          const acres = parseAcres(containerText);
          const county = parseCounty(containerText);

          if (maxPrice && price > maxPrice) return;
          if (minPrice && price < minPrice) return;
          if (minAcres && acres && acres < minAcres) return;
          if (maxAcres && acres && acres > maxAcres) return;

          results.push({
            id: `lf-${pid}`,
            title: title.substring(0, 200),
            price,
            acres,
            county,
            state,
            zip: '',
            listingUrl: fullUrl,
            source: 'LandFlip',
            ownerFinancing: containerText.toLowerCase().includes('owner financ'),
            description: title,
            scrapedAt: new Date().toISOString().split('T')[0],
          });
        });
      } catch (err) {
        console.error(`  [LandFlip] Error:`, err.message);
      }
    }
  }

  return results;
}
