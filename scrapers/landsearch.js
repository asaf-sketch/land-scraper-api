import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landsearch.com';

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

function getPriceSlug(maxPrice) {
  if (maxPrice <= 5000) return '/under-5000';
  if (maxPrice <= 10000) return '/under-10000';
  if (maxPrice <= 20000) return '/under-20000';
  if (maxPrice <= 50000) return '/under-50000';
  return '';
}

export async function scrapeLandsearch({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const slug = STATE_SLUGS[state.toLowerCase()];
    if (!slug) continue;

    // LandSearch working URL pattern: /properties/STATE?min_acres=X&max_price=Y
    const params = new URLSearchParams();
    if (minAcres > 0) params.set('min_acres', String(minAcres));
    if (maxPrice) params.set('max_price', String(maxPrice));
    const queryStr = params.toString() ? `?${params.toString()}` : '';
    const url = `${BASE_URL}/properties/${slug}${queryStr}`;
    console.log(`  [LandSearch] Fetching ${url}`);

    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.log(`  [LandSearch] HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // LandSearch has a structured listing format
      // Look for property cards
      $('a[href*="/listing/"], a[href*="/properties/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        // Must be an actual listing page, not a search/category page
        if (href.includes('/search') || href.includes('/county/')) return;
        if (!href.match(/\/\d{4,}/) && !href.match(/\/listing\//)) return;

        const title = $(el).text().trim();
        if (!title || title.length < 5 || title === 'View Details') return;

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;

        // Extract data from surrounding content
        const container = $(el).closest('div, article, li');
        const containerText = container.text() || '';

        const priceMatch = containerText.match(/\$([\d,]+)/);
        const acresMatch = containerText.match(/([\d.]+)\s*(?:acres?|ac)/i);
        const countyMatch = containerText.match(/([A-Za-z]+)\s*County/i);

        const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
        const acres = acresMatch ? parseFloat(acresMatch[1]) : null;

        if (price !== null && (price > maxPrice || price < minPrice)) return;
        if (acres !== null && minAcres > 0 && acres < minAcres) return;

        // Avoid duplicates within this scraper
        if (results.some(r => r.listingUrl === fullUrl)) return;

        results.push({
          id: `landsearch-${Date.now()}-${results.length}`,
          title: title.substring(0, 200),
          price,
          acres,
          county: countyMatch ? countyMatch[1] : 'Unknown',
          state,
          zip: '',
          listingUrl: fullUrl,
          source: 'LandSearch',
          ownerFinancing: containerText.toLowerCase().includes('owner financ'),
          description: title,
          scrapedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      console.error(`  [LandSearch] Error:`, err.message);
    }
  }

  return results;
}
