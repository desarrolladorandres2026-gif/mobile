import mongoose from 'mongoose';
import { config } from '../../config';
import * as M from '../../models';

async function main() {
  await mongoose.connect(config.mongodb.uri);
  const names = Object.keys(M).filter((k) => (M as any)[k]?.modelName);
  const results: [string, number][] = [];
  for (const n of names) {
    try {
      const c = await (M as any)[n].estimatedDocumentCount();
      results.push([n, c]);
    } catch {
      results.push([n, -1]);
    }
  }
  results.sort((a, b) => a[1] - b[1]);
  for (const [n, c] of results) console.log(c, n);
  await mongoose.disconnect();
}
main();
