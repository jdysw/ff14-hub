// Node >=22.12; type stripping loads the SAME schema used by Worker, no parallel validator.
import { readFile,writeFile } from 'node:fs/promises';
import { fishDataBundleSchema } from '../packages/fish-engine/src/index.ts';
const [input,output]=process.argv.slice(2);
if(!input || !output)throw new Error('Usage: node --experimental-strip-types scripts/prepare-fish-import.mjs input.json output.sql');
const bundle=fishDataBundleSchema.parse(JSON.parse(await readFile(input,'utf8')));
const quote=(text)=>"'"+text.replaceAll("'","''")+"'";
const statements=bundle.records.map((record)=>`INSERT INTO fish_catalog(region,fish_id,record_json) VALUES(${quote(record.region)},${record.id},${quote(JSON.stringify(record))}) ON CONFLICT(region,fish_id) DO UPDATE SET record_json=excluded.record_json;`);
// D1 execute handles transactional execution; no credentials or private progress in this output.
await writeFile(output,statements.join('\n')+'\n','utf8');
process.stdout.write(`Validated ${bundle.records.length} ${bundle.region} records; SQL: ${output}\n`);
