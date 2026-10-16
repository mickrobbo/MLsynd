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
async function minHtml(html){
  let out = '', i = 0, n = 0;
  const re = /<(script|style)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while((m = re.exec(html))){
    out += html.slice(i, m.index).replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
    const [whole, tag, attrs = '', body] = m;
    if(tag.toLowerCase() === 'script' && !/\ssrc=/i.test(attrs) && !/type=["'](application\/(ld\+)?json|text\/template)/i.test(attrs) && body.trim()){
      out += `<script${attrs}>${await minJs(body, `inline script #${++n}`)}</script>`;
    } else if(tag.toLowerCase() === 'style' && body.trim()){
      out += `<style${attrs}>${await minCss(body, 'inline style')}</style>`;
    } else out += whole;
    i = m.index + whole.length;
  }
  out += html.slice(i).replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  return out;
}

let saved = 0;
async function walk(dir){
  for(const ent of await fs.readdir(dir, { withFileTypes: true })){
    const rel = path.relative(ROOT, path.join(dir, ent.name));
    if(dir === ROOT && SKIP.has(ent.name)) continue;
    const src = path.join(dir, ent.name), dst = path.join(OUT, rel);
    if(ent.isDirectory()){ await fs.mkdir(dst, { recursive: true }); await walk(src); continue; }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const isRoot = dir === ROOT;
    if(isRoot && ent.name.endsWith('.html')){
      const s = await fs.readFile(src, 'utf8'); const o = await minHtml(s); saved += s.length - o.length; await fs.writeFile(dst, o);
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
console.log(`MLSynd build: dist/ ready, ${Math.round(saved / 1024)} KB of comments/whitespace removed.`);
