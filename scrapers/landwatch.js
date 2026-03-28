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
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

export async function scrapeLandwatch({ states, counties, maxPrice, minPrice, minAcres, maxAcres }) {
  const results = [];

  for (const state of states) {
    const slug = STATE_SLUGS[state.toLowerCase()];
    if (!slug) continue;

    // LandWatch working URL pattern: /{state}-land-for-sale
    // Price and acre filters are query params, not URL slugs
    const baseSearchUrl = `${BASE_URL}/${slug}-land-for-sale`;

    // Try multiple URL approaches
    const urlsToTry = [
      baseSearchUrl,
      `${baseSearchUrl}?minPrice=${minPrice || 0}&maxPrice=${maxPrice}`,
    ];

    for (const url of urlsToTry) {
      console.log(`  [LandWatch] Fetching ${url}`);

      try {
        const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          console.log(`  [LandWatch] HTTP ${response.status} for ${url}`);
          continue;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Method 1: Look for JSON-LD structured data
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const data = JSON.parse($(el).html());

            // Handle ItemList format
            if (data['@type'] === 'ItemList' && data.itemListElement) {
              for (const item of data.itemListElement) {
                const listing = item.item || item;
                processListing(listing, state, results, { maxPrice, minPrice, minAcres, maxAcres, counties });
              }
            }

            // Handle single listing
            if (data['@type'] === 'RealEstateListing' || data['@type'] === 'Product') {
              processListing(data, state, results, { maxPrice, minPrice, minAcres, maxAcres, counties });
            }
          } catch {}
        });

        // Method 2: Parse visible listing text with regex
        const bodyText = $('body').text();
        const listingPattern = /\$([\d,]+)\s*[•·]\s*([\d.]+)\s*Acres?/gi;
        let match;
        while ((match = listingPattern.exec(bodyText)) !== null) {
          const price = parseInt(match[1].replace(/,/g, ''));
          const acres = parseFloat(match[2]);

          if (price > maxPrice || price < (minPrice || 0)) continue;
          if (minAcres > 0 && acres < minAcres) continue;
          if (maxAcres < 1000 && acres > maxAcres) continue;

          // Get surrounding context for county/location
          const start = Math.max(0, match.index - 20);
          const end = Math.min(bodyText.length, match.index + match[0].length + 300);
          const context = bodyText.substring(start, end);

          const countyMatch = context.match(/([A-Za-z\s]+)\s*County/i);
          const county = countyMatch ? countyMatch[1].trim() : 'Unknown';
          const zipMatch = context.match(/OK\s*,?\s*(\d{5})/);
          const zip = zipMatch ? zipMatch[1] : '';

          // Apply county filter
          if (counties && counties.length > 0 && county !== 'Unknown') {
            if (!counties.some(c => c.toLowerCase() === county.toLowerCase())) continue;
          }

          const id = `landwatch-text-${price}-${acres}-${results.length}`;
          if (results.some(r => r.price === price && r.acres === acres)) continue;

          results.push({
            id,
            title: `${acres} Acres - ${county} County, OK`,
            price,
            acres,
            county,
            state,
            zip,
            listingUrl: baseSearchUrl,
            source: 'LandWatch',
            ownerFinancing: context.toLowerCase().includes('owner financ'),
            description: context.substring(0, 200).trim(),
            scrapedAt: new Date().toISOString(),
          });
        }

        // Method 3: Parse HTML property links
        $('a').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!href.match(/\/[a-z-]+-county-[a-z-]+\/\d+/i) &&
              !href.match(/\/listing\/\d+/) &&
              !href.match(/\/land-for-sale\/listing\//)) return;

          const title = $(el).text().trim();
          if (!title || title.length < 5) return;

          const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
          if (results.some(r => r.listingUrl === fullUrl)) return;

          const parentText = $(el).parent().text() || '';
          const priceMatch = parentText.match(/\$([\d,]+)/);
          const acresMatch = parentText.match(/([\d.]+)\s*(?:acres?|ac)/i);
          const countyMatch = title.match(/([A-Za-z]+)\s*County/i);

          const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
          const acres = acresMatch ? parseFloat(acresMatch[1]) : null;

          if (price !== null && (price > maxPrice || price < (minPrice || 0))) return;
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

        // If we got results, don't try the next URL
        if (results.length > 0) break;

      } catch (err) {
        console.error(`  [LandWatch] Error:`, err.message);
      }
    }
  }

  return results;
}

function processListing(listing, state, results, filters) {
  const price = listing.offers?.price || listing.price;
  const name = listing.name || '';
  const url = listing.url || '';
  if (!name) return;

  const numPrice = price ? parseFloat(price) : null;
  if (numPrice && (numPrice > filters.maxPrice || numPrice < (filters.minPrice || 0))) return;

  const acresMatch = name.match(/([\d.]+)\s*(?:acres?|ac)/i);
  const acres = acresMatch ? parseFloat(acresMatch[1]) : null;
  if (acres && filters.minAcres > 0 && acres < filters.minAcres) return;

  const countyMatch = name.match(/([A-Za-z]+)\s*County/i);
  const county = countyMatch ? countyMatch[1] : 'Unknown';

  const fullUrl = url.startsWith('http') ? url : `https://www.landwatch.com${url}`;

  results.push({
    id: `landwatch-${Date.now()}-${results.length}`,
    title: name,
    price: numPrice,
    acres,
    county,
    state,
    zip: '',
    listingUrl: fullUrl,
    source: 'LandWatch',
    ownerFinancing: (listing.description || '').toLowerCase().includes('owner financ'),
    description: (listing.description || name).substring(0, 200),
    scrapedAt: new Date().toISOString(),
  });
}
