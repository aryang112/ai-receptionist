/**
 * Read-only audit helper for Richa's public Wix website.
 *
 * Fetches the two public sitemaps, extracts human-readable page text, and
 * prints JSON to stdout. It never writes files or calls Phorest.
 *
 * Usage:
 *   npx tsx scripts/audit-website-services.ts
 *   npx tsx scripts/audit-website-services.ts --url <public-page-url>
 */

const SITE = 'https://www.richasthreading.com';

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    rdquo: '”',
    rsquo: '’',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, key: string) => {
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return named[key.toLowerCase()] ?? full;
  });
}

function visibleText(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  return decodeEntities(
    main
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/h[1-6]|\/li|\/section|\/div)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join('\n');
}

function xmlLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
    decodeEntities(match[1]!).trim()
  );
}

function firstText(html: string, hook: string): string | undefined {
  const pattern = new RegExp(
    `data-hook=["']${hook}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    'i'
  );
  const raw = html.match(pattern)?.[1];
  if (!raw) return undefined;
  const text = visibleText(raw).replace(/\n/g, ' ').trim();
  return text || undefined;
}

async function get(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ai-receptionist-read-only-content-audit/1.0' },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function inspect(url: string) {
  const html = await get(url);
  return {
    url,
    title:
      firstText(html, 'title-and-tagline-title') ??
      decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '')
        .replace(/\s*\|[\s\S]*$/, '')
        .trim(),
    duration: firstText(html, 'details-duration'),
    price: firstText(html, 'details-price'),
    text: visibleText(html),
  };
}

async function main() {
  const urlIndex = process.argv.indexOf('--url');
  if (urlIndex >= 0) {
    const url = process.argv[urlIndex + 1];
    if (!url?.startsWith(`${SITE}/`)) {
      throw new Error('--url must be a richasthreading.com page');
    }
    console.log(JSON.stringify(await inspect(url), null, 2));
    return;
  }

  const sitemap = await get(`${SITE}/sitemap.xml`);
  const sitemapUrls = xmlLocations(sitemap);
  const pageUrls = (
    await Promise.all(
      sitemapUrls.map(async (url) => xmlLocations(await get(url)))
    )
  ).flat();

  const rows = [];
  for (let index = 0; index < pageUrls.length; index += 4) {
    rows.push(
      ...(await Promise.all(pageUrls.slice(index, index + 4).map(inspect)))
    );
  }
  const summary = process.argv.includes('--summary');
  console.log(
    JSON.stringify(
      {
        auditedAt: new Date().toISOString(),
        totalPages: rows.length,
        bookingPages: rows.filter((row) => row.url.includes('/service-page/'))
          .length,
        staticPages: rows.filter((row) => !row.url.includes('/service-page/'))
          .length,
        rows: summary
          ? rows.map(({ url, title, duration, price }) => ({
              url,
              title,
              duration,
              price,
            }))
          : rows,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
