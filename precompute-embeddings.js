const { pipeline } = require('@huggingface/transformers');
const fs = require('fs');

const diagnoses = JSON.parse(fs.readFileSync('./src/diagnoses.json', 'utf8'));

function dxSearchText(dx) {
  return [dx.name, dx.description, dx.icd, dx.signs, dx.ddx, dx.treatment, dx.meds, dx.labs, dx.notes].filter(Boolean).join(' ');
}

async function computeEmbeddings(modelName, label) {
  console.log(`Loading ${label} (${modelName})...`);
  const extractor = await pipeline('feature-extraction', modelName, { dtype: 'q8' });

  const embeddings = {};
  for (let i = 0; i < diagnoses.length; i++) {
    const dx = diagnoses[i];
    const text = dxSearchText(dx);
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    embeddings['dx' + (i + 1)] = Array.from(output.data);

    if ((i + 1) % 10 === 0 || i === diagnoses.length - 1) {
      process.stdout.write(`\r  ${label}: ${i + 1}/${diagnoses.length}`);
    }
  }
  console.log(' ✓');
  return embeddings;
}

async function main() {
  console.log(`Pre-computing embeddings for ${diagnoses.length} diagnoses...\n`);

  const generalEmb = await computeEmbeddings('Xenova/all-MiniLM-L6-v2', 'MiniLM');
  const medEmb = await computeEmbeddings('Xenova/SapBERT-from-PubMedBERT-fulltext', 'SapBERT');

  // Quantize to float16 to save space (convert Float32 arrays to base64-encoded float16)
  // Actually, let's just round to 4 decimal places and store as JSON - simpler and good enough
  function quantize(emb) {
    const result = {};
    for (const [id, vec] of Object.entries(emb)) {
      result[id] = vec.map(v => Math.round(v * 10000) / 10000);
    }
    return result;
  }

  const output = {
    general: quantize(generalEmb),
    med: quantize(medEmb),
  };

  fs.writeFileSync('./src/embeddings.json', JSON.stringify(output));
  const sizeKB = Math.round(fs.statSync('./src/embeddings.json').size / 1024);
  console.log(`\nWrote src/embeddings.json (${sizeKB}KB)`);

  // Show embedding dimension
  const sampleKey = Object.keys(generalEmb)[0];
  console.log(`MiniLM dimension: ${generalEmb[sampleKey].length}`);
  console.log(`SapBERT dimension: ${medEmb[sampleKey].length}`);
}

main().catch(console.error);
