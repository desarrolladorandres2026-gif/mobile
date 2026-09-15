import mongoose from 'mongoose';
import { connectGuarded, parseArgs } from './common';
import { validateTeste } from './validateTeste';

/** `npm run teste:validate -- --db=<nombre>` — solo lectura. */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connectGuarded(typeof args.db === 'string' ? args.db : undefined);
  const report = await validateTeste({ checkImages: args['skip-images'] !== true, probeUrls: args['skip-images'] !== true });
  console.log(JSON.stringify(report.counts));
  for (const f of report.findings) console.log(`[${f.severity.toUpperCase()}] ${f.check}: ${f.detail}`);
  console.log(`\n${report.verdict === 'PASS' ? '✅' : '❌'} ${report.verdict} — ${report.findings.length} hallazgos`);
  await mongoose.disconnect();
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
