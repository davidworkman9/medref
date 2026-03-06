const fs = require('fs');
const existing = JSON.parse(fs.readFileSync('./src/diagnoses.json','utf8'));

// Normalize category names in existing data
existing.forEach(d => {
  if (d.cat === 'GI / Hepatology') d.cat = 'GI/Hepatology';
  if (d.cat === 'Obstetrics') d.cat = 'Obstetrics/Gynecology';
});

const batches = ['batch1','batch1b','batch2','batch3','batch4','batch5','batch6','batch8','batch9','batch10','batch11'];
let newDx = [];
batches.forEach(b => {
  const data = JSON.parse(fs.readFileSync(`./src/${b}.json`,'utf8'));
  newDx.push(...data);
});

// Deduplicate: existing takes priority, new ones only added if name not already present
const existingNames = new Set(existing.map(d => d.name));
const added = new Set();
const filtered = newDx.filter(d => {
  if (existingNames.has(d.name) || added.has(d.name)) return false;
  added.add(d.name);
  return true;
});

const all = [...existing, ...filtered];
console.log('Existing:', existing.length);
console.log('New unique:', filtered.length);
console.log('Total:', all.length);

// Count by category
const cats = {};
all.forEach(d => { cats[d.cat] = (cats[d.cat]||0)+1; });
console.log('By category:', JSON.stringify(cats, null, 2));

fs.writeFileSync('./src/diagnoses.json', JSON.stringify(all, null, 2));
console.log('Wrote src/diagnoses.json');
console.log('Need', 500 - all.length, 'more to reach 500');
