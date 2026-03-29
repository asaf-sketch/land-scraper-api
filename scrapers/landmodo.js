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

// Helper to format state name for URL
function formatStateForUrl(state) {
  return state.toLowerCase().replace(/\s+/g, '-');
}

// Helper to parse price from text
function parsePrice(text) {
  if (!text) return null;
  // Remove commas before parsing
  const cleanText = text.replace(/,/g, '');
  const match = cleanText.match(/\$\s*([\d]+(?:\.\d{1,2})?)/);
  if (match) {
    return parseFloat(match[1]);
  }
  return null;
}

// Helper to extract acres from text
function extractAcres(text) {
  if (!text) return null;
  const match = text.match(/([\d.]+)\s*(?:Acres?)/i);
  if (match) {
    return parseFloat(match[1]);
  }
  return null;
}

// Helper to extract location from text
function extractLocation(text) {
  if (!text) return { city: null, state: null, zip: null };
  // Look for pattern: City, ST ZIP
  const match = text.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})\s*(\d{5})/);
  if (match) {
    return {
      city: match[1].trim(),
      state: match[2],
      zip: match[3],
    };
  }
  return { city: null, state: null, zip: null };
}

export async function scrapeLandmodo({ states, counties, maxPrice, minPrice, minAcres, maxAcres, ownerFinancing = true }) {
  const results = [];

  for (const state of states) {
    const stateUrlFormat = formatStateForUrl(state);

    // Use confirmed working pattern: /properties/{state}
    const baseUrl = `${BASE_URL}/properties/${stateUrlFormat}`;

    console.log(`  [Landmodo] Scraping state: ${state}`);

    // Scrape up to 3 pages
    for (let page = 1; page <= 3; page++) {
      const url = page === 1
        ? baseUrl
        : `${baseUrl}?page=${page}`;

      let html = null;

      try {
        console.log(`  [Landmodo] Fetching ${url}`);
        const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          console.log(`  [Landmodo] Page ${page} not found or error`);
          break;
        }
        html = await response.text();

        // Check if we got actual content
        if (!html || html.length < 1000) {
          console.log(`  [Landmodo] Page ${page} returned empty or minimal content`);
          break;
        }
      } catch (err) {
        console.error(`  [Landmodo] Error fetching page ${page}:`, err.message);
        break;
      }

      const $ = cheerio.load(html);

      // Parse .search_result cards (confirmed HTML class from live site)
      const searchResults = $('.search_result');
      console.log(`  [Landmodo] Found ${searchResults.length} search results on page ${page}`);

      if (searchResults.length === 0) {
        console.log(`  [Landmodo] No results on page ${page}, stopping pagination`);
        break;
      }

      searchResults.each((_, cardEl) => {
        const $card = $(cardEl);

        // Get property link with slug (a[href*="/properties/"])
        const linkEl = $card.find('a[href*="/properties/"]').first();
        if (!linkEl.length) return;

        const href = linkEl.attr('href') || '';
        // Extract slug - should be something like /properties/xyz-title-slug or /properties/state/xyz-slug
        // Skip state-level pages (e.g., /properties/texas)
        const match = href.match(/\/properties\/([^/]+)\/([^/]+)/);
        const simpleMatch = href.match(/\/properties\/([^/]+)$/);

        let slug = null;
        if (match && match[2]) {
          // Multi-part URL like /properties/texas/xyz-slug
          slug = match[2];
        } else if (simpleMatch && simpleMatch[1] !== stateUrlFormat) {
          // Single slug, but not the state itself
          slug = simpleMatch[1];
        } else {
          return; // Skip state-level pages
        }

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
        const title = linkEl.text().trim();

        // Extract price - try .info_section text first, then full card text
        let price = null;
        const infoSection = $card.find('.info_section').text();
        if (infoSection) {
          price = parsePrice(infoSection);
        }
        if (price === null) {
          const cardText = $card.text();
          price = parsePrice(cardText);
        }

        // Extract acres from title
        const acres = extractAcres(title);

        // Extract location from .post-location-snippet or card text
        let location = null;
        const locSnippet = $card.find('.post-location-snippet').text();
        if (locSnippet) {
          location = extractLocation(locSnippet);
        }
        if (!location || !location.zip) {
          location = extractLocation($card.text());
        }

        // Apply filters
        // Price: if price=0, KEEP the listing - use l.price === 0 || l.price <= maxPrice
        if (price !== null && !(price === 0 || price <= maxPrice)) {
          return;
        }
        if (price !== null && minPrice && price < minPrice) {
          return;
        }

        // Acres filter
        if (acres !== null) {
          if (minAcres && minAcres > 0 && acres < minAcres) return;
          if (maxAcres && maxAcres < 1000 && acres > maxAcres) return;
        }

        // County filter
        if (counties && counties.length > 0 && location && location.city) {
          // Try to match county in location - this is heuristic since we parse city
          const countyLower = location.city.toLowerCase();
          if (!counties.some(c => c.toLowerCase() === countyLower)) {
            // For now, we'll include since county extraction is limited
            // In a real scenario, you'd need better county detection
          }
        }

        // Build result object
        const listing = {
          id: `lm-${slug}`,
          title,
          price,
          acres,
          county: location && location.city ? location.city : 'Unknown',
          state,
          zip: location && location.zip ? location.zip : '',
          listingUrl: fullUrl,
          source: 'Landmodo',
          ownerFinancing: ownerFinancing !== false ? true : ownerFinancing,
          description: title,
          scrapedAt: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
        };

        results.push(listing);
      });
    }
  }

  return results;
}
