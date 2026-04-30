import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();

const SALE_SLUG = process.env.SALE_ID ?? 'bookipi-flash-sale';

const TOTAL_STOCK = positiveInt(process.env.SALE_TOTAL_STOCK, 100);
const EDITION_TOTAL = positiveInt(process.env.SALE_EDITION_TOTAL, 100);
const EDITION_NUMBER = Math.min(
  positiveInt(process.env.SALE_EDITION_NUMBER, 47),
  EDITION_TOTAL,
);

const HOURS = 24;
const startsAt = new Date(Date.now() - 60_000);
const endsAt = new Date(Date.now() + HOURS * 60 * 60 * 1000);

const saleData = {
  slug: SALE_SLUG,
  name: process.env.SALE_NAME ?? 'Cloudrunner Limited Edition',
  tagline: process.env.SALE_TAGLINE ?? 'Sneaker drop · ultra limited',
  productImageEmoji: process.env.SALE_IMAGE_EMOJI ?? '👟',
  priceCents: positiveInt(process.env.SALE_PRICE_CENTS, 9_900),
  originalPriceCents: positiveInt(process.env.SALE_ORIGINAL_PRICE_CENTS, 24_900),
  currency: process.env.SALE_CURRENCY ?? 'AUD',
  editionNumber: EDITION_NUMBER,
  editionTotal: EDITION_TOTAL,
  totalStock: TOTAL_STOCK,
  remainingStock: TOTAL_STOCK,
  startsAt,
  endsAt,
};

async function main() {
  const sale = await prisma.sale.upsert({
    where: { slug: SALE_SLUG },
    update: saleData,
    create: saleData,
  });

  const purgedPurchases = await prisma.purchase.deleteMany({
    where: { saleId: sale.id },
  });

  const redisOutcome = await flushRedisForSale(SALE_SLUG);

  console.log('--- Seed summary ---');
  console.log(`Sale slug         : ${sale.slug}`);
  console.log(`Product           : ${sale.productImageEmoji}  ${sale.name}`);
  console.log(`Tagline           : ${sale.tagline}`);
  console.log(
    `Price             : ${formatPrice(sale.priceCents, sale.currency)} ` +
      `(was ${formatPrice(sale.originalPriceCents, sale.currency)})`,
  );
  console.log(
    `Edition           : ${pad3(sale.editionNumber)} / ${pad3(sale.editionTotal)}`,
  );
  console.log(
    `Stock             : ${sale.remainingStock} / ${sale.totalStock}`,
  );
  console.log(
    `Window            : ${sale.startsAt.toISOString()} → ${sale.endsAt.toISOString()}`,
  );
  console.log(`Purchases purged  : ${purgedPurchases.count}`);
  console.log(`Redis             : ${redisOutcome}`);
}

async function flushRedisForSale(slug: string): Promise<string> {
  const url = process.env.REDIS_URL;
  if (!url) {
    return 'skipped (REDIS_URL not set)';
  }

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  try {
    await client.connect();
    const keys = [
      `sale:${slug}:stock`,
      `sale:${slug}:buyers`,
      `sale:${slug}:version`,
      `sale:${slug}:simulation:stats`,
      `sale:${slug}:simulation:history`,
    ];
    const removed = await client.del(...keys);
    return `flushed ${removed} key(s)`;
  } catch (error) {
    return `unreachable (${(error as Error).message})`;
  } finally {
    client.disconnect();
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

main()
  .then(() => console.log('Seed finished.'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
