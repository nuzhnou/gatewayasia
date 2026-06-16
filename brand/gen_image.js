require('dotenv').config();
const fs = require('fs');

const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(s=>s.trim()).filter(Boolean);
if (!keys.length) { console.error('NO GEMINI KEY'); process.exit(1); }
const KEY = keys[0];

const prompt = process.argv[2] || 'Photorealistic cinematic marketing photograph. A confident young Western European professional in smart-casual attire stands on a rooftop terrace at golden-hour sunrise, looking toward a vibrant Southeast Asian city skyline (Vietnam/Thailand vibe) with palm trees, modern towers and a traditional temple in the distance. Warm golden light, deep teal and emerald tones, optimistic aspirational mood, a sense of new opportunity and a gateway to Asia. High-end editorial photography, shallow depth of field. No text, no logos, no watermark.';
const outFile = process.argv[3] || 'brand/thematic_1.png';
const models = ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

(async () => {
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } };
    try {
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { console.error(`[${model}] HTTP ${r.status}: ${JSON.stringify(j).slice(0,300)}`); continue; }
      const parts = j?.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData && p.inlineData.data);
      if (!img) { console.error(`[${model}] no image in response: ${JSON.stringify(j).slice(0,300)}`); continue; }
      fs.writeFileSync(outFile, Buffer.from(img.inlineData.data, 'base64'));
      console.log(`OK [${model}] -> ${outFile} (${Math.round(fs.statSync(outFile).size/1024)} KB)`);
      return;
    } catch (e) { console.error(`[${model}] ERR ${e.message}`); }
  }
  console.error('All models failed.');
  process.exit(2);
})();
