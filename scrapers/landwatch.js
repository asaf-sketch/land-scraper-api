import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.landwatch.com';

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

// LandWatch price range URL slugs
function getPriceSlug(maxPrice) {
  if (maxPrice <= 5000) return '/under-5000-dollars';
  if (maxPrice <= 10000) return '/under-10000-dollars';
  if (maxPrice <= 25000) return '/under-25000-dollars';
  if (maxPrice <= 50000) return '/under-50000-dollars';
  if (maxPrice <= 100000) return '/under-100000-dollars';
  return '';
}

export async function scrapeLandwatch({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const slug = STATE_SLUGS[state.toLowerCase()];
    if (!slug) continue;

    const priceSlug = getPriceSlug(maxPrice);
    const url = `${BASE_URL}/${slug}-land-for-sale${priceSlug}`;
    console.log(`  [LandWatch] Fetching ${url}`);

    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.log(`  [LandWatch] HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // LandWatch uses structured data (JSON-LD) for some listings
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).html());
          if (data['@type'] === 'RealEstateListing' || data['@type'] === 'Product') {
            const price = data.offers?.price || data.price;
            const name = data.name || '';
            const url = data.url || '';
            if (price && name && url) {
              results.push({
                id: `landwatch-${Date.now()}-${results.length}`,
                title: name,
                price: parseFloat(price),
                acres: null,
                county: 'Unknown',
                state,
                zip: '',
                listingUrl: url.startsWith('http') ? url : BASE_URL + url,
                source: 'LandWatch',
                ownerFinancing: false,
                description: name,
                scrapedAt: new Date().toISOString(),
              });
            }
          }
        } catch {}
      });

      // Also try to parse listing cards from HTML
      // LandWatch renders listings with React, so HTML parsing may get limited data
      // Look for any property-related links
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        // LandWatch property URLs pattern: /county/state/listing-name/id
        if (!href.match(/\/[a-z-]+-county-[a-z-]+\/\d+/i) && !href.match(/\/listing\/\d+/)) return;

        const title = $(el).text().trim();
        if (!title || title.length < 5) return;

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;

        // Try to extract price from nearby text
        const parentText = $(el).parent().text() || '';
        const priceMatch = parentText.match(/\$([\d,]+)/);
        const acresMatch = parentText.match(/([\d.]+)\s*(?:acres?|ac)/i);
        const countyMatch = title.match(/([A-Za-z]+)\s*County/i);

        const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
        const acres = acresMatch ? parseFloat(acresMatch[1]) : null;

        // Apply filters
        if (price !== null && (price > maxPrice || price < minPrice)) return;
        if (acres !== null && minAcres > 0 && acres < minAcres) return;

        results.push({
          id: `landwatch-${Date.now()}-${results.length}`,
          title,
          price,
          acres,
          county: countyMatch ? countyMatch[1] : 'Unknown',
          state,
          zip: '',
          listingUrl: fullUrl,
          source: 'LandWatch',
          ownerFinancing: parentText.toLowerCase().includes('owner financ'),
          description: title,
          scrapedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      console.error(`  [LandWatch] Error:`, err.message);
    }
  }

  return results;
}
