const fs = require('fs');
const files = ['batch1','batch1b','batch2','batch3','batch4','batch5','batch6','batch8','batch9','batch10','batch11'];
if (fs.existsSync('./src/batch7.json')) files.push('batch7');
let all = [];
const seen = new Set();
const existing = JSON.parse(fs.readFileSync('./src/diagnoses.json','utf8'));
existing.forEach(d => {
  if (d.cat === 'GI / Hepatology') d.cat = 'GI/Hepatology';
  if (d.cat === 'Obstetrics') d.cat = 'Obstetrics/Gynecology';
  seen.add(d.name);
  all.push(d);
});
for (const f of files) {
  const data = JSON.parse(fs.readFileSync('./src/'+f+'.json','utf8'));
  data.forEach(d => { if (!seen.has(d.name)) { seen.add(d.name); all.push(d); }});
}
console.log('Total unique:', all.length);
console.log('Need:', 500 - all.length, 'more');
const cats = {};
all.forEach(d => { cats[d.cat] = (cats[d.cat]||0)+1; });
Object.entries(cats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  '+k+': '+v));
