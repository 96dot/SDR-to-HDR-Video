// Scores variations of the smooth-motion picture-mixing shader (SDR2HDR_MIX in
// interp.js) on real frames saved with Alt+Shift+C. For each folder of four
// consecutive frames it makes the picture halfway between frames 1 and 3 and
// compares it with the real frame 2 (and frames 2 and 4 with frame 3), against
// what showing the plain nearer frame would score: the mean difference, out of
// 255, at 960 wide. The motion work is done once per pair; each variation only
// redoes the mixing, so many can be tried in one run.
// Run: node tests/tune.mjs sets.json variants.json [list]
//   sets.json:     [{ "name": "a", "dir": "folder holding frame1.png .. frame4.png" }, ...]
//   variants.json: { "label": [["text in the mix shader", "its replacement"], ...], ... }
//                  ("current": [] is the shader as it is)
// Mean error hides the worst places (swirls in a dark sky score low); look at
// the pictures too (tests/pairs.mjs). Needs Playwright and a Chromium.
import http from 'http'; import fs from 'fs'; import path from 'path';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const server = http.createServer((req,res)=>{const f=path.join(root,decodeURIComponent(req.url.split('?')[0]));if(!fs.existsSync(f)){res.statusCode=404;res.end();return;}res.setHeader('content-type',f.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(f));}).listen(0,'127.0.0.1');
const browser = await pw.chromium.launch({executablePath:process.env.CHROME||fs.readdirSync('/opt/pw-browsers').filter((x)=>x.startsWith('chromium-')).map((x)=>`/opt/pw-browsers/${x}/chrome-linux/chrome`)[0],headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader','--ignore-gpu-blocklist']});
const page = await browser.newPage(); page.on('pageerror',e=>console.error('PAGEERR',e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/tests/tune.html`); await page.evaluate(()=>window.ready);
const sets = JSON.parse(fs.readFileSync(process.argv[2],'utf8')); // [{name, dir}]: folders of frame1..4.png
for (const s of sets) for (const [i,j,k] of [[1,2,3],[2,3,4]]) {
  const b=(n)=>fs.readFileSync(`${s.dir}/frame${n}.png`).toString('base64');
  await page.evaluate(([n,a,t,c])=>window.addTriple(n,a,t,c),[`${s.name}:${i}${k}>${j}`,b(i),b(j),b(k)]);
}
const variants = JSON.parse(fs.readFileSync(process.argv[3],'utf8')); // {label: [[text in the mix shader, replacement], ...]}
const base = {};
for (const [label, subs] of Object.entries(variants)) {
  const r = await page.evaluate((s)=>window.runVariant(s),subs);
  const mean=(f)=>r.reduce((a,x)=>a+f(x),0)/r.length;
  const worse=r.filter(x=>x.made>x.plain*1.02).length;
  console.log(label.padEnd(34), 'made', mean(x=>x.made).toFixed(2), ' plain', mean(x=>x.plain).toFixed(2), ' ratio', mean(x=>x.made/x.plain).toFixed(3), ' worse-than-plain', worse+'/'+r.length, ' | ', r.map(x=>x.made.toFixed(0)).join(' '));
  if (process.argv[4]) console.log(r.map(x=>`${x.name} ${x.made.toFixed(1)}/${x.plain.toFixed(1)}`).join('\n'));
}
await browser.close(); server.close();
