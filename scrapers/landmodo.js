import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landmodo.com';

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
};

export async function scrapeLandmodo({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const slug = STATE_SLUGS[state.toLowerCase()];
    if (!slug) continue;

    const url = `${BASE_URL}/properties/${slug}`;
    console.log(`  [Landmodo] Fetching ${url}`);

    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.log(`  [Landmodo] HTTP ${response.status} for ${slug}`);
        continue;
      }

      const html = await response.text();
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

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
        propertyLinks.set(propId, { title, url: fullUrl, propId });
      });

      // Now find prices - they appear as text content in specific elements
      // Landmodo shows prices on property images like "$7986.00"
      const priceMap = new Map();
      $('*').each((_, el) => {
        const text = $(el).text().trim();
        if (/^\$[\d,]+\.\d{2}$/.test(text)) {
          // Walk up to find associated property link
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

        // Parse title for structured data
        const acresMatch = prop.title.match(/([\d.]+)\s*Acres?/i);
        const acres = acresMatch ? parseFloat(acresMatch[1]) : null;

        const locMatch = prop.title.match(/,\s*([A-Za-z\s.]+),\s*OK\s*(\d+)/);
        const countyInTitle = prop.title.match(/([A-Za-z]+)\s*County/i);
        const county = countyInTitle ? countyInTitle[1] : (locMatch ? locMatch[1].trim() : null);
        const zip = locMatch ? locMatch[2] : null;

        // Apply filters
        if (price !== null) {
          if (price > maxPrice || price < minPrice) continue;
        }
        if (acres !== null) {
          if (minAcres > 0 && acres < minAcres) continue;
          if (maxAcres < 1000 && acres > maxAcres) continue;
        }
        // County filter
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
          ownerFinancing: true, // Landmodo specializes in owner financing
          description: prop.title,
          scrapedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`  [Landmodo] Error scraping ${slug}:`, err.message);
    }
  }

  return results;
}
