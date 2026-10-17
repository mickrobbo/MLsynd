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
const SKIP = new Set(['dist', 'node_modules', '.git', '.github', 'tests', 'netlify', 'build.mjs', 'package.json', 'package-lock.json', 'netlify.toml', '.gitignore', 'README.md', 'firebase-rules.json']); // rules are pasted into the Firebase console, never needed on the live site

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
// v211: checks that stop a broken update going live. Any failure here
// fails the Netlify build, so the site stays on the last good version.
async function preflight(){
  const problems = [];
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  // every local script and stylesheet the page loads must exist
  for(const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"'#]+)["']/gi)){
    const ref = m[1];
    if(/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
    const file = ref.split('?')[0].replace(/^\//, '');
    try{ await fs.access(path.join(ROOT, file)); }catch(e){ problems.push(`index.html loads ${file}, which doesn't exist`); }
  }
  // the version shown in the app and version.json must match
  const v = (html.match(/APP_VERSION = "([^"]+)"/) || [])[1];
  try{
    const vj = JSON.parse(await fs.readFile(path.join(ROOT, 'version.json'), 'utf8'));
    if(v && vj.version !== v) problems.push(`APP_VERSION is ${v} but version.json says ${vj.version}`);
  }catch(e){ problems.push('version.json is not valid JSON: ' + e.message); }
  for(const f of ['firebase-rules.json', 'dashboard-manifest.json']){
    try{ JSON.parse(await fs.readFile(path.join(ROOT, f), 'utf8')); }catch(e){ if(e.code !== 'ENOENT') problems.push(`${f} is not valid JSON: ${e.message}`); }
  }
  // every server function must at least parse
  const fnDir = path.join(ROOT, 'netlify', 'functions');
  const walkFns = async (dir) => {
    for(const ent of await fs.readdir(dir, { withFileTypes: true })){
      const p = path.join(dir, ent.name);
      if(ent.isDirectory()){ if(ent.name !== 'node_modules') await walkFns(p); continue; }
      if(!/\.(mjs|js)$/.test(ent.name)) continue;
      try{ await transform(await fs.readFile(p, 'utf8'), { loader: 'js', format: 'esm', target: 'es2022', logLevel: 'silent' }); }
      catch(e){ problems.push(`${path.relative(ROOT, p)} has a syntax error: ${String(e.message).split('\n').slice(0, 3).join(' ')}`); }
    }
  };
  try{ await walkFns(fnDir); }catch(e){}
  if(problems.length) throw new Error('Pre-deploy checks failed:\n - ' + problems.join('\n - '));
}
await preflight();
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await walk(ROOT);
console.log(`MLSynd build: dist/ ready, ${Math.round((saved - extracted) / 1024)} KB of comments/whitespace removed, ${Math.round(extracted / 1024)} KB of script moved out of index.html.`);
