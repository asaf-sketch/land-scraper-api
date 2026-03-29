import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landwatch.com';

// Support ALL US states - dynamically convert state name to slug
function getStateSlug(state) {
  return state.toLowerCase().replace(/\s+/g, '-');
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

export async function scrapeLandwatch({ states, counties, maxPrice, minPrice, minAcres, maxAcres, ownerFinancing }) {
  const results = [];

  for (const state of states) {
    const stateSlug = getStateSlug(state);
    console.log(`[LandWatch] Processing state: ${state} (slug: ${stateSlug})`);

    // Build base URL with state slug
    let url = `${BASE_URL}/${stateSlug}-land-for-sale`;

    // Add county filter if specified
    if (counties && counties.length > 0) {
      const county = counties[0];
      const countySlug = county.toLowerCase().replace(/\s+/g, '-');
      url = `${BASE_URL}/${stateSlug}-land-for-sale/${countySlug}-county`;
      console.log(`[LandWatch] Using county filter: ${url}`);
    }

    // Add price filter if maxPrice is under 50k
    if (maxPrice && maxPrice < 50000) {
      // Determine price range slug
      let priceSlug = '/price-under-49999';
      if (maxPrice < 25000) {
        priceSlug = '/price-under-24999';
      } else if (maxPrice < 35000) {
        priceSlug = '/price-under-34999';
      }
      url = url + priceSlug;
      console.log(`[LandWatch] Using price filter: ${url}`);
    }

    // Add owner financing filter if requested
    if (ownerFinancing) {
      url = url + '/owner-financing';
      console.log(`[LandWatch] Using owner financing filter: ${url}`);
    }

    console.log(`[LandWatch] Fetching ${url}`);

    try {
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        console.log(`[LandWatch] HTTP ${response.status} for ${url}`);
        continue;
      }

      const html = await response.text();
      console.log(`[LandWatch] Received ${html.length} bytes`);

      const $ = cheerio.load(html);

      // Method 1: Parse JSON-LD structured data first
      console.log(`[LandWatch] Parsing JSON-LD structured data...`);
      const jsonLdProcessed = parseJsonLd($, state, results, {
        maxPrice, minPrice, minAcres, maxAcres, counties
      });
      console.log(`[LandWatch] Found ${jsonLdProcessed} listings from JSON-LD`);

      // Method 2: Fallback to HTML card parsing with a[href*="/pid/"] selectors
      console.log(`[LandWatch] Parsing HTML cards with PID links...`);
      const htmlProcessed = parseHtmlCards($, state, url, results, {
        maxPrice, minPrice, minAcres, maxAcres, counties
      });
      console.log(`[LandWatch] Found ${htmlProcessed} listings from HTML cards`);

      console.log(`[LandWatch] Total results so far: ${results.length}`);

    } catch (err) {
      console.error(`[LandWatch] Error fetching ${url}:`, err.message);
    }
  }

  console.log(`[LandWatch] Final result count: ${results.length}`);
  return results;
}

/**
 * Parse JSON-LD structured data (ItemList with itemListElement)
 */
function parseJsonLd($, state, results, filters) {
  let processed = 0;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      console.log(`[LandWatch] Found JSON-LD type: ${data['@type']}`);

      // Handle ItemList format with itemListElement array
      if (data['@type'] === 'ItemList' && data.itemListElement && Array.isArray(data.itemListElement)) {
        console.log(`[LandWatch] Processing ItemList with ${data.itemListElement.length} items`);

        for (const item of data.itemListElement) {
          const listing = item.item || item;
          if (processJsonLdListing(listing, state, results, filters)) {
            processed++;
          }
        }
      }

      // Handle single listing
      if (data['@type'] === 'RealEstateListing' || data['@type'] === 'Product') {
        if (processJsonLdListing(data, state, results, filters)) {
          processed++;
        }
      }
    } catch (err) {
      console.log(`[LandWatch] Failed to parse JSON-LD:`, err.message);
    }
  });

  return processed;
}

/**
 * Process individual JSON-LD listing
 */
function processJsonLdListing(listing, state, results, filters) {
  const price = listing.offers?.price || listing.price;
  const name = listing.name || '';
  const url = listing.url || '';
  const description = listing.description || '';

  if (!name) return false;

  console.log(`[LandWatch] Processing JSON-LD listing: ${name.substring(0, 50)}`);

  // Parse price
  const numPrice = price ? parseFloat(String(price).replace(/[$,]/g, '')) : null;
  if (numPrice !== null) {
    if (numPrice > (filters.maxPrice || Infinity) || numPrice < (filters.minPrice || 0)) {
      console.log(`[LandWatch] Filtered out by price: $${numPrice}`);
      return false;
    }
  }

  // Parse acres
  const acresMatch = name.match(/([\d.]+)\s*acres/i);
  const acres = acresMatch ? parseFloat(acresMatch[1]) : null;
  if (acres !== null) {
    if (filters.minAcres > 0 && acres < filters.minAcres) {
      console.log(`[LandWatch] Filtered out by min acres: ${acres}`);
      return false;
    }
    if (filters.maxAcres < 1000 && acres > filters.maxAcres) {
      console.log(`[LandWatch] Filtered out by max acres: ${acres}`);
      return false;
    }
  }

  // Parse county from URL: /{county}-county-{state}-{type}-for-sale/pid/{id}
  let county = 'Unknown';
  let pid = null;
  if (url) {
    const countyMatch = url.match(/\/([a-z-]+)-county-[a-z-]+-for-sale\/pid\/(\d+)/i);
    if (countyMatch) {
      county = countyMatch[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      pid = countyMatch[2];
    }
  }

  // Apply county filter
  if (filters.counties && filters.counties.length > 0) {
    if (!filters.counties.some(c => c.toLowerCase() === county.toLowerCase())) {
      console.log(`[LandWatch] Filtered out by county: ${county}`);
      return false;
    }
  }

  // Check for owner financing
  const hasOwnerFinancing = description.toLowerCase().includes('owner financ') ||
                           name.toLowerCase().includes('owner financ');

  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const id = pid ? `lw-${pid}` : `lw-${Date.now()}-${results.length}`;

  // Check for duplicates
  if (results.some(r => r.id === id)) {
    console.log(`[LandWatch] Skipping duplicate: ${id}`);
    return false;
  }

  results.push({
    id,
    title: name,
    price: numPrice,
    acres,
    county,
    state,
    zip: '',
    listingUrl: fullUrl,
    source: 'LandWatch',
    ownerFinancing: hasOwnerFinancing,
    description: description.substring(0, 300),
    scrapedAt: new Date().toISOString().split('T')[0],
  });

  console.log(`[LandWatch] Added listing: ${id} - ${name.substring(0, 40)}`);
  return true;
}

/**
 * Parse HTML cards with a[href*="/pid/"] selectors (fallback method)
 */
function parseHtmlCards($, state, baseUrl, results, filters) {
  let processed = 0;

  $('a[href*="/pid/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href) return;

    console.log(`[LandWatch] Found PID link: ${href}`);

    // Extract PID from URL
    const pidMatch = href.match(/\/pid\/(\d+)/);
    if (!pidMatch) return;
    const pid = pidMatch[1];

    // Get the card container
    let cardElement = $(el);
    for (let i = 0; i < 5; i++) {
      cardElement = cardElement.parent();
      if (!cardElement.length) break;
    }

    const cardText = cardElement.text() || $(el).parent().text();
    const cardHtml = cardElement.html() || $(el).parent().html();

    // Parse price - look for $XX,XXX pattern
    const priceMatch = cardText.match(/\$[\d,]+/);
    let price = null;
    if (priceMatch) {
      price = parseFloat(priceMatch[0].replace(/[$,]/g, ''));
    }

    if (price !== null) {
      if (price > (filters.maxPrice || Infinity) || price < (filters.minPrice || 0)) {
        console.log(`[LandWatch] Filtered out by price: $${price}`);
        return;
      }
    }

    // Parse acres - look for X.XX acres pattern
    const acresMatch = cardText.match(/([\d.]+)\s*acres/i);
    let acres = null;
    if (acresMatch) {
      acres = parseFloat(acresMatch[1]);
    }

    if (acres !== null) {
      if (filters.minAcres > 0 && acres < filters.minAcres) {
        console.log(`[LandWatch] Filtered out by min acres: ${acres}`);
        return;
      }
      if (filters.maxAcres < 1000 && acres > filters.maxAcres) {
        console.log(`[LandWatch] Filtered out by max acres: ${acres}`);
        return;
      }
    }

    // Parse location from URL pattern: /{county}-county-{state}-{type}-for-sale/pid/{id}
    let county = 'Unknown';
    const countyMatch = baseUrl.match(/\/([a-z-]+)-county-[a-z-]+-for-sale/) ||
                        href.match(/\/([a-z-]+)-county-[a-z-]+-for-sale/i);
    if (countyMatch) {
      county = countyMatch[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // Apply county filter
    if (filters.counties && filters.counties.length > 0) {
      if (!filters.counties.some(c => c.toLowerCase() === county.toLowerCase())) {
        console.log(`[LandWatch] Filtered out by county: ${county}`);
        return;
      }
    }

    const title = $(el).text().trim() || `${acres ? acres + ' Acres' : 'Property'} - ${county}, ${state}`;
    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const id = `lw-${pid}`;

    // Check for duplicates
    if (results.some(r => r.id === id)) {
      console.log(`[LandWatch] Skipping duplicate: ${id}`);
      return;
    }

    // Check for owner financing
    const hasOwnerFinancing = cardText.toLowerCase().includes('owner financ');

    results.push({
      id,
      title,
      price,
      acres,
      county,
      state,
      zip: '',
      listingUrl: fullUrl,
      source: 'LandWatch',
      ownerFinancing: hasOwnerFinancing,
      description: cardText.substring(0, 300).trim(),
      scrapedAt: new Date().toISOString().split('T')[0],
    });

    console.log(`[LandWatch] Added HTML card listing: ${id}`);
    processed++;
  });

  return processed;
}
