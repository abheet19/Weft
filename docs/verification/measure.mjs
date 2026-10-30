import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const ARTIFACT = 'file:///C:/Users/abhee/AppData/Local/Temp/claude/C--Users-abhee/cde2c043-8321-461e-84c5-b72ebcc9eb01/scratchpad/redesigns/weft.html';
const LIVE = process.env.WEFT_URL || 'http://127.0.0.1:5173';
const OUT = 'D:/code/Weft/docs/verification';
mkdirSync(OUT, { recursive: true });

const PROPS = ['color','backgroundColor','fontFamily','fontSize','lineHeight','fontWeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginBottom','gap','borderRadius','boxShadow','backdropFilter','width','height','borderTopWidth','borderTopColor','borderBottomWidth'];

const RECENTS = JSON.stringify([
  {id:'7fg900ilsyh9', title:'Fugue CRDT — merge conflict notes', words:612, updatedAt: Date.now()-120000},
  {id:'a1b2c3d4e5f6', title:'Weekly sync agenda', words:210, updatedAt: Date.now()-3600000},
  {id:'k9m3n7p1q5r2', title:'Interleaving regression test plan', words:430, updatedAt: Date.now()-7200000},
  {id:'z8y7x6w5v4u3', title:'Tombstone compaction design', words:880, updatedAt: Date.now()-90000000},
  {id:'h4j5k6l7m8n9', title:'Onboarding doc', words:150, updatedAt: Date.now()-180000000},
  {id:'p0o9i8u7y6t5', title:'Release checklist', words:95, updatedAt: Date.now()-260000000},
]);

async function styleOf(page, selector){
  return await page.evaluate(({sel, props})=>{
    const el = document.querySelector(sel);
    if(!el) return null;
    const cs = getComputedStyle(el);
    const o = {};
    for(const p of props) o[p] = cs[p];
    const r = el.getBoundingClientRect();
    o._w = Math.round(r.width); o._h = Math.round(r.height);
    return o;
  }, {sel: selector, props: PROPS});
}

async function setupArtifact(page, screen){
  await page.evaluate((s)=>{
    document.documentElement.setAttribute('data-theme','dark');
    const app = document.getElementById('app');
    app.setAttribute('data-accent','cyan');
    // trigger goScreen by clicking rail btn
    const btn = document.querySelector('.rail-btn[data-nav="'+s+'"]');
    if(btn) btn.click();
  }, screen);
  await page.waitForTimeout(150);
}

async function measureArtifact(vp){
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: vp});
  await page.goto(ARTIFACT);
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(400);
  const out = {};
  // documents
  await setupArtifact(page,'documents');
  out.doc = {};
  for(const [k,sel] of Object.entries(A_DOCS)) out.doc[k]=await styleOf(page,sel);
  // trigger empty state
  await page.evaluate(()=>{ const i=document.getElementById('docSearch'); i.value='zzzznomatch'; i.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.waitForTimeout(200);
  out.doc.empty = await styleOf(page,'.docs-empty');
  out.doc.emptyH = await styleOf(page,'.docs-empty h3');
  out.doc.emptyP = await styleOf(page,'.docs-empty p');
  // history
  await setupArtifact(page,'history');
  out.hist = {};
  for(const [k,sel] of Object.entries(A_HIST)) out.hist[k]=await styleOf(page,sel);
  // settings
  await setupArtifact(page,'settings');
  out.set = {};
  for(const [k,sel] of Object.entries(A_SET)) out.set[k]=await styleOf(page,sel);
  // rail (measured on settings screen, same everywhere)
  out.rail = {};
  for(const [k,sel] of Object.entries(A_RAIL)) out.rail[k]=await styleOf(page,sel);
  await page.screenshot({path:`${OUT}/artifact-${vp.width}-settings.png`, fullPage:true});
  await setupArtifact(page,'documents');
  await page.screenshot({path:`${OUT}/artifact-${vp.width}-documents.png`, fullPage:true});
  await setupArtifact(page,'history');
  await page.screenshot({path:`${OUT}/artifact-${vp.width}-history.png`, fullPage:true});
  await browser.close();
  return out;
}

async function measureLive(vp){
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: vp});
  const page = await ctx.newPage();
  await page.addInitScript((r)=>{
    try{ localStorage.setItem('weft:recents', r);
      localStorage.setItem('weft:ui', JSON.stringify({theme:'dark',flat:false,accent:'cyan'})); }catch(e){}
  }, RECENTS);
  await page.goto(LIVE+'/');
  await page.evaluate(()=>{ document.documentElement.setAttribute('data-theme','dark'); document.documentElement.setAttribute('data-accent','cyan'); });
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(600);
  const out = {};
  out.doc = {};
  for(const [k,sel] of Object.entries(L_DOCS)) out.doc[k]=await styleOf(page,sel);
  await page.screenshot({path:`${OUT}/live-${vp.width}-documents.png`, fullPage:true});
  // empty state: type no-match in search
  const search = await page.$('.docs-search input');
  if(search){ await search.fill('zzzznomatch'); await page.waitForTimeout(250); }
  out.doc.empty = await styleOf(page,'.docs-empty');
  out.doc.emptyH = await styleOf(page,'.docs-empty h2');
  out.doc.emptyP = await styleOf(page,'.docs-empty p');
  // history: click nav
  await page.getByRole('tab',{name:'History'}).click();
  await page.waitForTimeout(900);
  await page.evaluate(()=>document.fonts.ready);
  out.hist = {};
  for(const [k,sel] of Object.entries(L_HIST)) out.hist[k]=await styleOf(page,sel);
  await page.screenshot({path:`${OUT}/live-${vp.width}-history.png`, fullPage:true});
  // settings
  await page.getByRole('tab',{name:'Settings'}).click();
  await page.waitForTimeout(500);
  out.set = {};
  for(const [k,sel] of Object.entries(L_SET)) out.set[k]=await styleOf(page,sel);
  await page.screenshot({path:`${OUT}/live-${vp.width}-settings.png`, fullPage:true});
  out.rail = {};
  for(const [k,sel] of Object.entries(L_RAIL)) out.rail[k]=await styleOf(page,sel);
  await ctx.close();
  await browser.close();
  return out;
}

// element maps
const A_RAIL = { rail:'.rail', brand:'.rail-brand', activeBtn:'.rail-btn.active', idleBtn:'.rail-btn:not(.active)' };
const L_RAIL = { rail:'.navrail', brand:'.navrail-brand', activeBtn:'.navrail-btn.on', idleBtn:'.navrail-btn:not(.on)' };

const A_DOCS = { title:'.docs-title', sub:'.docs-sub', primaryBtn:'.btn-primary', card:'.doc-card', cardIcon:'.doc-card-icon', cardH3:'.doc-card h3', count:'.docs-count' };
const L_DOCS = { title:'.screenpage-h', sub:'.screenpage-sub', primaryBtn:'.btn.primary', card:'.doc-card', cardIcon:'.doc-card-icon', cardH3:'.doc-card h3', count:'.docs-count' };

const A_HIST = { title:'.hs-header h1', sub:'.hs-header p', preview:'.hs-preview', restore:'.hs-restore-row', restoreBtn:'.hs-restore-row .btn' };
const L_HIST = { title:'.screenpage-h', sub:'.screenpage-sub', preview:'.history-preview', restore:'.history-restore', restoreBtn:'.history-restore .btn' };

const A_SET = { title:'.set-header h1', navActive:'.set-nav button.active', navIdle:'.set-nav button:not(.active)', group:'.set-group', groupH3:'.set-group h3', fieldRow:'.field-row', segmented:'.segmented', segActive:'.segmented button.active', sw:'.switch', swatch:'.swatch' };
const L_SET = { title:'.screenpage-h', navActive:'.settings-nav button.on', navIdle:'.settings-nav button:not(.on)', group:'.panel', groupH3:'.panel-h h2', fieldRow:'.set-row', segmented:'.segmented', segActive:'.segmented button.on', sw:'.switch', swatch:'.accent-swatch' };

function diff(a,b){
  const rows=[];
  for(const p of PROPS.concat(['_w','_h'])){
    if(!a||!b){ continue; }
    if(String(a[p])!==String(b[p])) rows.push(`${p}: artifact=${a[p]} | live=${b[p]}`);
  }
  return rows;
}

const results = {};
for(const vp of [{width:1280,height:800},{width:375,height:812}]){
  const A = await measureArtifact(vp);
  const L = await measureLive(vp);
  const vpKey = vp.width+'w';
  results[vpKey] = {};
  for(const group of ['rail','doc','hist','set']){
    for(const key of Object.keys(A[group]||{})){
      const av=A[group][key], lv=(L[group]||{})[key];
      const d = diff(av,lv);
      const label = `${group}.${key}`;
      if(av===null && lv===null){ results[vpKey][label]='BOTH-MISSING'; }
      else if(av===null){ results[vpKey][label]='artifact-missing'; }
      else if(lv===null){ results[vpKey][label]='LIVE-MISSING'; }
      else if(d.length){ results[vpKey][label]=d; }
    }
  }
}
writeFileSync(`${OUT}/diff.json`, JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
