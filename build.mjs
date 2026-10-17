// MLSynd deploy build (2026-10-16).
// Copies the site into dist/ and, on the way, strips comments and extra
// whitespace from index.html (inline scripts + styles), dashboard.css and
// every root .js file. GitHub keeps the fully commented source; phones get
// the slimmer copy. Names are NOT shortened (no identifier mangling): the
// casino scripts and index.html share globals across <script> tags, so only
// whitespace/comments are touched — the code itself runs exactly as written.
// If anything here throws, the Netlify deploy fails and the live site simply
// stays on the previous version.
import { promises as fs } from 'fs';
import path from 'path';
import { transform } from 'esbuild';
import { createHash } from 'crypto';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'dist');
const SKIP = new Set(['dist', 'node_modules', '.git', 'netlify', 'build.mjs', 'package.json', 'package-lock.json', 'netlify.toml', '.gitignore', 'README.md', 'firebase-rules.json']); // rules are pasted into the Firebase console, never needed on the live site

const jsOpts = { loader: 'js', minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, legalComments: 'none', charset: 'utf8', target: 'es2020' };
const cssOpts = { loader: 'css', minifyWhitespace: true, minifySyntax: false, legalComments: 'none', charset: 'utf8' };

async function minJs(code, label){
  try{ return (await transform(code, jsOpts)).code; }
  catch(e){ throw new Error(`JS in ${label} failed to process: ${e.message}`); }
}
async function minCss(code, label){
  try{ return (await transform(code, cssOpts)).code; }
  catch(e){ throw new Error(`CSS in ${label} failed to process: ${e.message}`); }
}
// v200: big inline scripts in index.html are written out as their own
// files, named by a hash of their contents. Same order, same globals, so
// they run exactly as before, but the page itself is far smaller to parse,
// the browser can download them in parallel, and the phone keeps a
// compiled copy between opens (it can't do that for inline scripts).
const EXTRACT_MIN = 4096;
async function writeChunk(code, n){
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
  const name = `js/app-${n}.${hash}.js`;
  await fs.mkdir(path.join(OUT, 'js'), { recursive: true });
  await fs.writeFile(path.join(OUT, name), code);
  extracted += code.length;
  return name;
}
async function minHtml(html, extract){
  let out = '', i = 0, n = 0;
  const re = /<(script|style)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while((m = re.exec(html))){
    out += html.slice(i, m.index).replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
    const [whole, tag, attrs = '', body] = m;
    if(tag.toLowerCase() === 'script' && !/\ssrc=/i.test(attrs) && !/type=["'](application\/(ld\+)?json|text\/template)/i.test(attrs) && body.trim()){
      const code = await minJs(body, `inline script #${++n}`);
      if(extract && code.length >= EXTRACT_MIN){ out += `<script${attrs} src="${await writeChunk(code, n)}"></script>`; }
      else out += `<script${attrs}>${code}</script>`;
    } else if(tag.toLowerCase() === 'style' && body.trim()){
      out += `<style${attrs}>${await minCss(body, 'inline style')}</style>`;
    } else out += whole;
    i = m.index + whole.length;
  }
  out += html.slice(i).replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  return out;
}

let saved = 0, extracted = 0;
async function walk(dir){
  for(const ent of await fs.readdir(dir, { withFileTypes: true })){
    const rel = path.relative(ROOT, path.join(dir, ent.name));
    if(dir === ROOT && SKIP.has(ent.name)) continue;
    const src = path.join(dir, ent.name), dst = path.join(OUT, rel);
    if(ent.isDirectory()){ await fs.mkdir(dst, { recursive: true }); await walk(src); continue; }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const isRoot = dir === ROOT;
    if(isRoot && ent.name.endsWith('.html')){
      const s = await fs.readFile(src, 'utf8'); const o = await minHtml(s, ent.name === 'index.html'); saved += s.length - o.length; await fs.writeFile(dst, o);
    } else if(isRoot && ent.name.endsWith('.css')){
      const s = await fs.readFile(src, 'utf8'); const o = await minCss(s, ent.name); saved += s.length - o.length; await fs.writeFile(dst, o);
    } else if(isRoot && ent.name.endsWith('.js') && ent.name !== 'sw.js'){
      const s = await fs.readFile(src, 'utf8'); const o = await minJs(s, ent.name); saved += s.length - o.length; await fs.writeFile(dst, o);
    } else {
      await fs.copyFile(src, dst);
    }
  }
}
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await walk(ROOT);
console.log(`MLSynd build: dist/ ready, ${Math.round((saved - extracted) / 1024)} KB of comments/whitespace removed, ${Math.round(extracted / 1024)} KB of script moved out of index.html.`);
