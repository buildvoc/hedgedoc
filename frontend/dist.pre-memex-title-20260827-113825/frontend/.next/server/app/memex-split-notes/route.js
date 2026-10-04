"use strict";(()=>{var e={};e.id=26322,e.ids=[26322],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},93977:e=>{e.exports=require("node:fs/promises")},48790:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>T,patchFetch:()=>L,requestAsyncStorage:()=>O,routeModule:()=>y,serverHooks:()=>x,staticGenerationAsyncStorage:()=>M});var n={};r.r(n),r.d(n,{POST:()=>A,dynamic:()=>p,runtime:()=>l});var o=r(38708),s=r(63996),i=r(73831),a=r(93977),c=r(16395);let l="nodejs",p="force-dynamic",u=new Set(["draft","stable","experimental"]);function d(e){let t=e.trim(),r=t.match(/\/n\/([^/?#]+)/);return r?decodeURIComponent(r[1]):t.replace(/^https?:\/\/[^/]+\//,"").replace(/^n\//,"").split(/[?#]/)[0].trim()}function m(e){let t=e.replace(/\r\n/g,"\n");if(!t.startsWith("---\n"))return t;let r=t.indexOf("\n---\n",4);return -1===r?t:t.slice(r+5)}function h(e){let t=e.match(/^---\n([\s\S]*?)\n---/)?.[1],r=t?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];if(r)return r.trim();let n=m(e);return n.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()??"Untitled source note"}function g(e){let t=m(e),r=[...t.matchAll(/^#\s+(.+?)\s*$/gm)];if(r.length<2)for(let e=2;e<=6;e+=1){let n="#".repeat(e),o=RegExp(`^${n}\\s+(.+?)\\s*$`,"gm"),s=[...t.matchAll(o)];if(s.length>=2){r=s;break}}return 0===r.length?[{id:1,title:h(e),anchor:"",content:t.trim()}]:r.map((e,n)=>{let o=e.index??0,s=r[n+1]?.index??t.length,i=e[1].trim();return{id:n+1,title:i,anchor:i.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[`*_~()[\]{}:;,.!?'"\\/]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,""),content:t.slice(o,s).trim()}})}function f(e){return JSON.stringify(e.replace(/\r?\n/g," ").trim())}async function E(){return function(e){let t={};for(let r of e.split("\n")){let e=r.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);e&&(t[e[1]]=e[2].trim().replace(/^['"]|['"]$/g,""))}return t}(await (0,a.readFile)("/data/projects/hedgedoc/.env.memex","utf8"))}async function w(e,t){let r=t.MEMEX_API_TOKEN;if(!r)throw Error("MEMEX_API_TOKEN missing");let n=t.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/,"")??"http://127.0.0.1:3100/api/v2",o=await fetch(`${n}/notes/${encodeURIComponent(e)}/content`,{headers:{Authorization:`Bearer ${r}`},cache:"no-store"});if(!o.ok)throw Error(`Source HedgeDoc GET HTTP ${o.status}`);return o.text()}async function S(e){let t=await E(),r=d(e);if(!r)throw Error("Source HedgeDoc URL or alias required");let n=await w(r,t),o=g(n);if(o.length<2)throw Error("Source note does not contain enough sections to split");let s=t.MEMEX_OLLAMA_URL??t.OLLAMA_URL??t.OLLAMA_HOST??"http://192.168.1.99:11434",i=t.MEMEX_OLLAMA_MODEL??t.OLLAMA_MODEL??"gemma4:26b",a=h(n),c=o.map(e=>`
SECTION ${e.id}
TITLE: ${e.title}
ANCHOR: #${e.anchor}

${e.content.slice(0,4500)}
`.trim()).join("\n\n---\n\n"),l=`
You are deciding how ONE existing HedgeDoc should be divided into
a useful number of NEW standalone HedgeDocs.

SOURCE TITLE:
${a}

SOURCE SECTIONS:

${c}

TASK

Decide how many new HedgeDocs are useful.

You decide the number. Do NOT assume one new note per heading.

Related sections may be grouped into one new HedgeDoc.
Distinct topics should become separate HedgeDocs.

Return the SMALLEST useful number of standalone notes while preserving
the meaningful structure of the source.

IMPORTANT

- Do not rewrite or summarize the source text.
- Do not invent content.
- You are ONLY deciding how the original sections are grouped.
- Every section ID must appear EXACTLY ONCE.
- Never duplicate a section between proposed HedgeDocs.
- Keep section order logical.
- Produce between 1 and ${Math.min(12,o.length)} proposed HedgeDocs.
- Give each proposed note a concise standalone title.
- Explain briefly why those sections belong together.

Return JSON only:

{
  "summary": "short explanation of the split",
  "notes": [
    {
      "title": "New HedgeDoc title",
      "reason": "why these sections belong together",
      "sectionIds": [1, 2]
    }
  ]
}
`.trim(),p=await fetch(`${s.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:i,stream:!1,format:"json",options:{temperature:.2},messages:[{role:"user",content:l}]})});if(!p.ok)throw Error(`Ollama HTTP ${p.status}`);let u=await p.json(),m=String(u?.message?.content??"").trim(),f=JSON.parse(m=m.replace(/^```json\s*/i,"").replace(/^```\s*/,"").replace(/\s*```$/,""));if(!Array.isArray(f.notes)||0===f.notes.length)throw Error("LLM returned no proposed HedgeDocs");let S=new Set(o.map(e=>e.id)),$=new Set,A=[];for(let e of f.notes.slice(0,12)){let t=Array.isArray(e.sectionIds)?e.sectionIds.map(Number).filter(e=>Number.isInteger(e)&&S.has(e)&&!$.has(e)):[];0!==t.length&&(t.sort((e,t)=>e-t),t.forEach(e=>$.add(e)),A.push({title:String(e.title??"Untitled derived note").trim(),reason:String(e.reason??"").trim(),sectionIds:t,status:"draft"}))}if($.size!==o.length){let e=o.filter(e=>!$.has(e.id)).map(e=>e.id);throw Error(`LLM split omitted source sections: ${e.join(", ")}`)}return{alias:r,sourceTitle:a,sectionCount:o.length,sections:o.map(e=>({id:e.id,title:e.title,anchor:e.anchor})),summary:String(f.summary??"").trim(),proposals:A}}async function $(e,t){let r=await E(),n=d(e);if(!n)throw Error("Source HedgeDoc URL or alias required");let o=new Map(g(await w(n,r)).map(e=>[e.id,e])),s=r.MEMEX_API_TOKEN;if(!s)throw Error("MEMEX_API_TOKEN missing");let i=r.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/,"")??"http://127.0.0.1:3100/api/v2",a=(r.MEMEX_HEDGEDOC_BASE_URL??"http://192.168.1.142:8180").replace(/\/$/,""),c=[],l=[];for(let e of t)try{let t=String(e.title??"").trim();if(!t)throw Error("Title required");let r=u.has(String(e.status))?String(e.status):"draft",l=[...new Set((e.sectionIds??[]).map(Number).filter(e=>o.has(e)))].sort((e,t)=>e-t);if(0===l.length)throw Error("No source sections selected");let p=l.map(e=>o.get(e)),d=p.map(e=>e.anchor?`${a}/n/${n}#${e.anchor}`:`${a}/n/${n}`),m=String(e.reason??"").replace(/\r?\n/g," ").trim(),h=["---","type: document","okf_type: Source",`title: ${f(t)}`,`description: ${f(m)}`,"tags:","  - derived-section","  - llm-split",`status: ${r}`,"sources:",...d.map(e=>`  - ${f(e)}`),"---","",`# ${t}`,"",...p.flatMap(e=>[e.content,""])].join("\n").trimEnd()+"\n",g=await fetch(`${i}/notes`,{method:"POST",headers:{Authorization:`Bearer ${s}`,"Content-Type":"text/markdown"},body:h});if(!g.ok)throw Error(`HedgeDoc POST HTTP ${g.status}`);let E=await g.json(),w=E?.metadata?.primaryAlias;if(!w)throw Error("Created note response contained no primaryAlias");c.push({title:t,status:r,alias:w,url:`${a}/n/${w}`})}catch(t){l.push({title:String(e.title??"Untitled"),error:t instanceof Error?t.message:"Create failed"})}return{created:c,failures:l}}async function A(e){try{let t=await e.json();if("analyze"===t.action)return c.NextResponse.json(await S(String(t.source??"")));if("create"===t.action){let e=Array.isArray(t.proposals)?t.proposals:[];if(0===e.length)return c.NextResponse.json({error:"No proposed HedgeDocs selected"},{status:400});return c.NextResponse.json(await $(String(t.source??""),e))}return c.NextResponse.json({error:"Unknown action"},{status:400})}catch(e){return c.NextResponse.json({error:e instanceof Error?e.message:"Split operation failed"},{status:500})}}let y=new o.AppRouteRouteModule({definition:{kind:s.x.APP_ROUTE,page:"/memex-split-notes/route",pathname:"/memex-split-notes",filename:"route",bundlePath:"app/memex-split-notes/route"},resolvedPagePath:"/home/hp/hedgedoc-build-overlap/frontend/src/app/memex-split-notes/route.ts",nextConfigOutput:"standalone",userland:n}),{requestAsyncStorage:O,staticGenerationAsyncStorage:M,serverHooks:x}=y,T="/memex-split-notes/route";function L(){return(0,i.patchFetch)({serverHooks:x,staticGenerationAsyncStorage:M})}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),n=t.X(0,[9561,13472],()=>r(48790));module.exports=n})();