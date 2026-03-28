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
};

export async function scrapeLandflip({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const slug = STATE_SLUGS[state.toLowerCase()];
    if (!slug) continue;

    // LandFlip URL format: /land-for-sale/STATE/MINPRICE-minprice/MAXPRICE-maxprice
    const url = `${BASE_URL}/land-for-sale/${slug}/${minPrice || 0}-minprice/${maxPrice}-maxprice`;
    console.log(`  [LandFlip] Fetching ${url}`);

    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.log(`  [LandFlip] HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // LandFlip uses structured data
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).html());
          // Could be a single listing or an array
          const listings = Array.isArray(data) ? data : data.itemListElement ? data.itemListElement : [data];

          for (const item of listings) {
            const listing = item.item || item;
            if (!listing.name || !listing.url) continue;

            const price = listing.offers?.price || null;
            const acresMatch = listing.name.match(/([\d.]+)\s*(?:acres?|ac)/i);
            const countyMatch = listing.name.match(/([A-Za-z]+)\s*County/i);

            if (price && price > maxPrice) continue;

            results.push({
              id: `landflip-${Date.now()}-${results.length}`,
              title: listing.name,
              price: price ? parseFloat(price) : null,
              acres: acresMatch ? parseFloat(acresMatch[1]) : null,
              county: countyMatch ? countyMatch[1] : 'Unknown',
              state,
              zip: '',
              listingUrl: listing.url.startsWith('http') ? listing.url : BASE_URL + listing.url,
              source: 'LandFlip',
              ownerFinancing: (listing.description || '').toLowerCase().includes('owner financ'),
              description: listing.description?.substring(0, 200) || listing.name,
              scrapedAt: new Date().toISOString(),
            });
          }
        } catch {}
      });

      // Also parse HTML property cards
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.match(/\/property\/\d+/) && !href.match(/\/land-for-sale\/[a-z]+\/[a-z]+-county\/\d+/)) return;

        const title = $(el).text().trim();
        if (!title || title.length < 5) return;

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
        if (results.some(r => r.listingUrl === fullUrl)) return;

        const container = $(el).closest('div, article');
        const containerText = container.text() || '';
        const priceMatch = containerText.match(/\$([\d,]+)/);
        const acresMatch = containerText.match(/([\d.]+)\s*(?:acres?|ac)/i);
        const countyMatch = containerText.match(/([A-Za-z]+)\s*County/i);

        const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
        if (price !== null && price > maxPrice) return;

        results.push({
          id: `landflip-${Date.now()}-${results.length}`,
          title: title.substring(0, 200),
          price,
          acres: acresMatch ? parseFloat(acresMatch[1]) : null,
          county: countyMatch ? countyMatch[1] : 'Unknown',
          state,
          zip: '',
          listingUrl: fullUrl,
          source: 'LandFlip',
          ownerFinancing: containerText.toLowerCase().includes('owner financ'),
          description: title,
          scrapedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      console.error(`  [LandFlip] Error:`, err.message);
    }
  }

  return results;
}
