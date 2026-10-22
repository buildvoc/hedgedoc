"use strict";(()=>{var e={};e.id=26322,e.ids=[26322],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},93977:e=>{e.exports=require("node:fs/promises")},49411:e=>{e.exports=require("node:path")},94969:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>G,patchFetch:()=>J,requestAsyncStorage:()=>q,routeModule:()=>z,serverHooks:()=>K,staticGenerationAsyncStorage:()=>F});var n={};r.r(n),r.d(n,{POST:()=>k,dynamic:()=>f,runtime:()=>u});var o=r(38708),i=r(63996),a=r(73831),s=r(93977),l=r(16395),c=r(1608);let u="nodejs",f="force-dynamic",d=new Set(["draft","stable","experimental"]);function p(e){let t=e.trim(),r=t.match(/\/n\/([^/?#]+)/);return r?decodeURIComponent(r[1]):t.replace(/^https?:\/\/[^/]+\//,"").replace(/^n\//,"").split(/[?#]/)[0].trim()}function m(e){let t=e.replace(/\r\n/g,"\n");if(!t.startsWith("---\n"))return t;let r=t.indexOf("\n---\n",4);return -1===r?t:t.slice(r+5)}function h(e){return e.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[`*_~()[\]{}:;,.!?'"\\/]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"")}function g(e){let t=e.match(/^---\n([\s\S]*?)\n---/)?.[1],r=t?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];if(r)return r.trim();let n=m(e);return n.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()??"Untitled source note"}function y(e){let t=m(e),r=[...t.matchAll(/^#\s+(.+?)\s*$/gm)];if(r.length<2)for(let e=2;e<=6;e+=1){let n="#".repeat(e),o=RegExp(`^${n}\\s+(.+?)\\s*$`,"gm"),i=[...t.matchAll(o)];if(i.length>=2){r=i;break}}return 0===r.length?[{id:1,title:g(e),anchor:"",content:t.trim()}]:r.map((e,n)=>{let o=e.index??0,i=r[n+1]?.index??t.length,a=e[1].trim();return{id:n+1,title:a,anchor:h(a),content:t.slice(o,i).trim()}})}function b(e){return"object"==typeof e&&null!==e&&!Array.isArray(e)}function E(e){if(!b(e))return;let t=e.$ref;return"string"==typeof t?t:void 0}function $(e){return Array.isArray(e)?e.map(E).filter(e=>!!e):[]}function w(e){let t=m(e),r=t.indexOf('"schema_name"');if(r<0)return null;let n=t.lastIndexOf("{",r);for(;n>=0;){try{let e=JSON.parse(t.slice(n).trim());if(b(e)&&"DoclingDocument"===e.schema_name)return e}catch{}n=t.lastIndexOf("{",n-1)}return null}function S(e,t){let r=t.match(/^#\/([A-Za-z0-9_]+)\/(\d+)$/);if(!r)return null;let n=e[r[1]],o=Number(r[2]);if(!Array.isArray(n))return null;let i=n[o];return b(i)?i:null}function N(e,t=900){if("string"!=typeof e)return;let r=e.replace(/\s+/g," ").trim();if(r)return r.length<=t?r:`${r.slice(0,t)}…`}function v(e,t,r=1800){let n=[],o=0;for(let i of t){let t=S(e,i),a=N(t?.text,700);if(a){if(o+a.length>r)break;n.push(`${i}: ${a}`),o+=a.length}}return n.length>0?n.join(" | "):void 0}function O(e){let t=e.data;if(!b(t)||!Array.isArray(t.table_cells))return;let r=t.table_cells.slice(0,80).map(e=>b(e)?N(e.text,160):void 0).filter(e=>!!e);return r.length>0?N(r.join(" | "),2200):void 0}function A(e,t,r){let n="string"==typeof t.label?t.label:"node",o=N(t.text,120);if(o)return o;let i=v(e,$(t.captions),160);return i?`${n}: ${i}`:`${n} ${r}`}function D(e){return"furniture"===e.content_layer}function T(e,t,r){let n="string"==typeof t.label?t.label:"node",o=$(t.children),i=$(t.captions),a=$(t.footnotes),s=E(t.parent),l="number"==typeof t.level?t.level:void 0,c=Array.isArray(t.prov)?[...new Set(t.prov.map(e=>b(e)&&"number"==typeof e.page_no?e.page_no:void 0).filter(e=>void 0!==e))]:[];return{ref:r,label:n,...s?{parent:s}:{},...void 0!==l?{level:l}:{},...N(t.text)?{text:N(t.text)}:{},...o.length>0?{children:o}:{},...o.length>0?{childNodes:o.slice(0,40).flatMap(t=>{let r=S(e,t);if(!r)return[];let n="string"==typeof r.label?r.label:"node",o=N(r.text,320);return[{ref:t,label:n,..."number"==typeof r.level?{level:r.level}:{},...o?{text:o}:{}}]})}:{},...i.length>0?{captions:i}:{},...a.length>0?{footnotes:a}:{},...c.length>0?{pages:c}:{},...v(e,o)?{childText:v(e,o)}:{},...v(e,i,800)?{captionText:v(e,i,800)}:{},...O(t)?{tableText:O(t)}:{}}}function x(e){let t=e.body;if(!b(t))return[];let r=$(t.children).flatMap(t=>{let r=S(e,t);return!r||D(r)?[]:[{ref:t,node:r}]}),n=r.flatMap(({node:e},t)=>"section_header"===e.label?[t]:[]);return 0===n.length?function(e){let t=e.body;return b(t)?$(t.children).flatMap(t=>{let r=S(e,t);return!r||D(r)?[]:[{ref:t,node:r}]}).map(({ref:t,node:r},n)=>({id:n+1,title:A(e,r,t),anchor:"",content:JSON.stringify(T(e,r,t)),ref:t,refs:[t],label:"string"==typeof r.label?r.label:"node"})):[]}(e):n.map((t,o)=>{let i=r[t],a=n[o+1]??r.length,s=r.slice(0===o?0:t,a),l=s.map(({ref:e})=>e),c=A(e,i.node,i.ref),u="number"==typeof i.node.level?i.node.level:void 0;return{id:o+1,title:c,anchor:h(c),content:JSON.stringify({headerRef:i.ref,...void 0!==u?{level:u}:{},refs:l,units:s.map(({ref:t,node:r})=>T(e,r,t))}),ref:i.ref,refs:l,label:"section_header"}})}let C=Symbol("docling-drop");function _(e,t=!0){return Array.isArray(e)?e.flatMap(e=>_(e,t)):b(e)?1===Object.keys(e).length&&"string"==typeof e.$ref?[e.$ref]:Object.entries(e).flatMap(([e,r])=>"self_ref"===e||t&&"parent"===e?[]:_(r,t)):[]}function I(e){return e.match(/^#\/([^/]+)\/(\d+)$/)?.[1]}function M(e){let t=e.match(/^#\/([^/]+)\/(\d+)$/);return t?Number(t[2]):-1}function R(e){let t=new Set(["#/body","#/furniture"]);for(let r of Object.values(e))if(Array.isArray(r))for(let e of r)b(e)&&"string"==typeof e.self_ref&&t.add(e.self_ref);let r=_(e,!1).filter(e=>!t.has(e));if(r.length>0)throw Error(`Dangling Docling refs after materialization: ${[...new Set(r)].slice(0,20).join(", ")}`);let n=e.body;if(!b(n)||!Array.isArray(n.children)||0===n.children.length)throw Error("Materialized DoclingDocument has no body.children")}function j(e){return JSON.stringify(e.replace(/\r?\n/g," ").trim())}async function P(){return function(e){let t={};for(let r of e.split("\n")){let e=r.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);e&&(t[e[1]]=e[2].trim().replace(/^['"]|['"]$/g,""))}return t}(await (0,s.readFile)("/data/projects/hedgedoc/.env.memex","utf8"))}async function U(e,t){let r=t.MEMEX_API_TOKEN;if(!r)throw Error("MEMEX_API_TOKEN missing");let n=t.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/,"")??"http://127.0.0.1:3100/api/v2",o=await fetch(`${n}/notes/${encodeURIComponent(e)}/content`,{headers:{Authorization:`Bearer ${r}`},cache:"no-store"});if(!o.ok)throw Error(`Source HedgeDoc GET HTTP ${o.status}`);return o.text()}async function H(e){let t=await P(),r=await (0,c.OQ)(),n=p(e);if(!n)throw Error("Source HedgeDoc URL or alias required");let o=await U(n,t),i=w(o),a=i?"docling":"markdown",s=i?x(i):y(o);if(s.length<2)throw Error(i?"DoclingDocument does not contain enough semantic sections to split":"Source note does not contain enough sections to split");let l=r.provider,u=r.baseUrl.replace(/\/$/,""),f=r.defaultModel,d=i&&"string"==typeof i.name?i.name:g(o),m=s.map(e=>i?`
SECTION ${e.id}
HEADER REF: ${e.ref??""}
BODY REFS: ${(e.refs??[]).join(", ")}
TYPE: ${e.label??"section"}
TITLE: ${e.title}
STRUCTURE: ${e.content}
`.trim():`
SECTION ${e.id}
TITLE: ${e.title}
ANCHOR: #${e.anchor}

${e.content.slice(0,4500)}
`.trim()).join("\n\n---\n\n"),h=[{role:"user",content:function(e,t){if(e.length>t)throw Error(`Split prompt is ${e.length} characters; Memex maxPromptChars is ${t}. Increase the setting instead of truncating Docling sections.`);return e}(i?`
You are segmenting ONE DoclingDocument into a useful number of
standalone HedgeDocs using its NATIVE DOCUMENT STRUCTURE.

SOURCE TITLE:
${d}

DOCLING SEMANTIC SECTIONS IN CANONICAL READING ORDER:

${m}

TASK

Choose semantic segment boundaries from the DoclingDocument tree.
The SECTION order above is derived from section_header boundaries over body.children.
Furniture nodes are excluded. Each SECTION carries the top-level body refs that must move with it.

Return the SMALLEST useful number of coherent standalone notes while
preserving the meaningful document hierarchy.

STRUCTURAL RULES

- section_header nodes define the semantic SECTION boundaries; use level to respect hierarchy.
- group/list nodes stay attached to their surrounding semantic section; their children stay with the group.
- table nodes stay attached to their surrounding semantic section and must not be split internally.
- picture nodes stay attached to their surrounding semantic section; use captions/nearby section context when deciding grouping.
- ordinary text stays in reading order beneath its semantic section.
- child refs and caption refs are structural evidence, not additional SECTION IDs.
- Never convert the document to Markdown for this decision.
- Do not rewrite or summarize source content.
- Do not invent content.
- Every SECTION ID must appear EXACTLY ONCE.
- Never duplicate a SECTION between proposed HedgeDocs.
- Each proposed HedgeDoc must contain a CONTIGUOUS run of SECTION IDs.
- Preserve the canonical SECTION order.
- Produce between 1 and ${Math.min(12,s.length)} proposed HedgeDocs.
- Give each proposed note a concise standalone title.
- Explain briefly which Docling structural signals justify each segment.

Return SECTION IDs in the field named sectionIds.

Return JSON only:

{
  "summary": "short explanation of the structural segmentation",
  "notes": [
    {
      "title": "New HedgeDoc title",
      "reason": "Docling structural reason for this segment",
      "sectionIds": [1, 2]
    }
  ]
}
`.trim():`
You are deciding how ONE existing HedgeDoc should be divided into
a useful number of NEW standalone HedgeDocs.

SOURCE TITLE:
${d}

SOURCE SECTIONS:

${m}

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
- Produce between 1 and ${Math.min(12,s.length)} proposed HedgeDocs.
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
`.trim(),r.maxPromptChars)}],b="llamacpp"===l?`${u}/chat/completions`:`${u}/api/chat`,E="llamacpp"===l?{model:f,stream:!1,temperature:r.temperature,messages:h}:{model:f,stream:!1,format:"json",options:{num_ctx:r.numCtx,temperature:r.temperature},messages:h},$=await fetch(b,{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(1e3*r.timeoutSeconds),body:JSON.stringify(E)});if(!$.ok){let e=await $.text();throw Error(`${l} HTTP ${$.status}: ${e.slice(0,500)}`)}let S=await $.json(),N=String("llamacpp"===l?S?.choices?.[0]?.message?.content??"":S?.message?.content??"").trim(),v=JSON.parse(N=N.replace(/^```json\s*/i,"").replace(/^```\s*/,"").replace(/\s*```$/,""));if(!Array.isArray(v.notes)||0===v.notes.length)throw Error("LLM returned no proposed HedgeDocs");let O=new Set(s.map(e=>e.id)),A=new Set,D=[];for(let e of v.notes.slice(0,12)){let t=Array.isArray(e.sectionIds)?e.sectionIds.map(Number).filter(e=>Number.isInteger(e)&&O.has(e)&&!A.has(e)):[];if(0!==t.length){if(t.sort((e,t)=>e-t),i){for(let e=1;e<t.length;e+=1)if(t[e]!==t[e-1]+1)throw Error(`LLM returned a non-contiguous Docling segment: ${t.join(", ")}`)}t.forEach(e=>A.add(e)),D.push({title:String(e.title??"Untitled derived note").trim(),reason:String(e.reason??"").trim(),sectionIds:t,status:"draft"})}}if(A.size!==s.length){let e=s.filter(e=>!A.has(e.id)).map(e=>e.id);throw Error(`LLM split omitted source sections: ${e.join(", ")}`)}return{alias:n,sourceTitle:d,sourceKind:a,canCreate:!0,sectionCount:s.length,sections:s.map(e=>({id:e.id,title:e.title,anchor:e.anchor,ref:e.ref,refs:e.refs,label:e.label})),summary:String(v.summary??"").trim(),proposals:D}}async function L(e,t,r=!1){let n=await P(),o=p(e);if(!o)throw Error("Source HedgeDoc URL or alias required");let i=await U(o,n),a=w(i),s=new Map((a?x(a):y(i)).map(e=>[e.id,e])),l=n.MEMEX_API_TOKEN;if(!l)throw Error("MEMEX_API_TOKEN missing");let c=n.MEMEX_HEDGEDOC_API_URL?.replace(/\/$/,"")??"http://127.0.0.1:3100/api/v2",u=(n.MEMEX_HEDGEDOC_BASE_URL??"http://192.168.1.142:8180").replace(/\/$/,""),f=[],m=[],h=[];for(let e of t)try{let t,i;let p=String(e.title??"").trim();if(!p)throw Error("Title required");let m=d.has(String(e.status))?String(e.status):"draft",y=[...new Set((e.sectionIds??[]).map(Number).filter(e=>s.has(e)))].sort((e,t)=>e-t);if(0===y.length)throw Error(a?"No Docling structural units selected":"No source sections selected");if(a){for(let e=1;e<y.length;e+=1)if(y[e]!==y[e-1]+1)throw Error(`Docling creation requires contiguous structural units: ${y.join(", ")}`)}let $=y.map(e=>s.get(e)),S=String(e.reason??"").replace(/\r?\n/g," ").trim();if(a){var g;let e=$.flatMap(e=>{let t=e.refs??(e.ref?[e.ref]:[]);if(0===t.length)throw Error(`Docling semantic section ${e.id} has no body refs`);return t}),r=function(e,t,r){let n=function(e){let t=new Map;for(let r of Object.values(e))if(Array.isArray(r))for(let e of r)b(e)&&"string"==typeof e.self_ref&&t.set(e.self_ref,e);return t}(e),o=t.filter(e=>n.has(e));if(o.length!==t.length)throw Error("Selected Docling segment contains unresolved body refs");if(0===o.length)throw Error("Selected Docling segment contains no body refs");let i=new Set,a=[...o];for(;a.length>0;){let e=a.shift();if(i.has(e))continue;let t=n.get(e);if(t)for(let r of(i.add(e),_(t)))n.has(r)&&!i.has(r)&&a.push(r)}let s=new Map;for(let e of i){let t=I(e);if(!t)continue;let r=s.get(t)??[];r.push(e),s.set(t,r)}for(let e of s.values())e.sort((e,t)=>M(e)-M(t));let l=new Map;for(let[e,t]of s)t.forEach((t,r)=>{l.set(t,`#/${e}/${r}`)});let c=new Set(o),u=(e,t,r)=>{if(Array.isArray(e))return e.flatMap(e=>{let n=u(e,t,r);return n===C?[]:[n]});if(!b(e))return e;if(1===Object.keys(e).length&&"string"==typeof e.$ref){let n=e.$ref;if("parent"===r){if(t&&c.has(t))return{$ref:"#/body"};let e=l.get(n);return e?{$ref:e}:"#/body"===n||"#/furniture"===n?{$ref:n}:{$ref:"#/body"}}let o=l.get(n);return o?{$ref:o}:"#/body"===n||"#/furniture"===n?{$ref:n}:C}let n={};for(let[r,o]of Object.entries(e)){if("self_ref"===r&&"string"==typeof o){n[r]=l.get(o)??o;continue}let e=u(o,t,r);e!==C&&(n[r]=e)}return n},f={...e,name:r};for(let[t,r]of Object.entries(e))Array.isArray(r)&&r.some(e=>b(e)&&"string"==typeof e.self_ref&&I(e.self_ref)===t)&&(f[t]=(s.get(t)??[]).map(e=>{let t=n.get(e);if(!t)throw Error(`Missing Docling node during materialization: ${e}`);let r=u(t,e);if(!b(r))throw Error(`Invalid rewritten Docling node: ${e}`);return r}));let d=u(b(e.body)?{...e.body,self_ref:"#/body"}:{self_ref:"#/body"});if(!b(d))throw Error("Could not materialize Docling body");if(d.children=o.map(e=>({$ref:l.get(e)})),f.body=d,b(e.furniture)){let t=Array.isArray(e.furniture.children)?e.furniture.children:[],r=u({...e.furniture,self_ref:"#/furniture"});b(r)&&(r.children=t.flatMap(e=>{let t=E(e),r=t?l.get(t):void 0;return r?[{$ref:r}]:[]}),f.furniture=r)}return function(e,t){let r=t.pages;if(!b(r))return;let n=new Set;for(let[t,r]of Object.entries(e))"pages"!==t&&function e(t,r){if(Array.isArray(t)){t.forEach(t=>e(t,r));return}if(b(t))for(let[n,o]of("number"==typeof t.page_no&&Number.isInteger(t.page_no)&&r.add(t.page_no),Object.entries(t)))"pages"!==n&&e(o,r)}(r,n);e.pages=Object.fromEntries(Object.entries(r).filter(([e])=>{let t=Number(e);return Number.isInteger(t)&&n.has(t)}))}(f,e),R(f),f}(a,e,p);i=r,g=`${u}/n/${o}`,t=["---","type: document","okf_type: Source",`title: ${j(p)}`,`description: ${j(S)}`,"tags:","  - derived-docling-segment","  - llm-split",`status: ${m}`,"sources:",`  - ${j(g)}`,"---","",`# ${p}`,"",JSON.stringify(r,null,2),""].join("\n")}else{let e=$.map(e=>e.anchor?`${u}/n/${o}#${e.anchor}`:`${u}/n/${o}`);t=["---","type: document","okf_type: Source",`title: ${j(p)}`,`description: ${j(S)}`,"tags:","  - derived-section","  - llm-split",`status: ${m}`,"sources:",...e.map(e=>`  - ${j(e)}`),"---","",`# ${p}`,"",...$.flatMap(e=>[e.content,""])].join("\n").trimEnd()+"\n"}if(r){h.push({sourceKind:a?"docling":"markdown",title:p,status:m,...i?{document:i}:{markdown:t}});continue}let N=await fetch(`${c}/notes`,{method:"POST",headers:{Authorization:`Bearer ${l}`,"Content-Type":"text/markdown"},body:t});if(!N.ok)throw Error(`HedgeDoc POST HTTP ${N.status}`);let v=await N.json(),O=v?.metadata?.primaryAlias;if(!O)throw Error("Created note response contained no primaryAlias");if(a){let e=await U(O,n),t=w(e);if(!t)throw Error("Created note did not persist a DoclingDocument");R(t)}f.push({title:p,status:m,alias:O,url:`${u}/n/${O}`})}catch(t){m.push({title:String(e.title??"Untitled"),error:t instanceof Error?t.message:"Create failed"})}return{created:f,failures:m,previews:h}}async function k(e){try{let t=await e.json();if("analyze"===t.action)return l.NextResponse.json(await H(String(t.source??"")));if("preview"===t.action){let e=t.proposal;if(!e||"object"!=typeof e)return l.NextResponse.json({error:"Proposed HedgeDoc required"},{status:400});let r=await L(String(t.source??""),[e],!0);if(r.failures.length>0)return l.NextResponse.json({error:r.failures[0].error},{status:400});let n=r.previews[0];if(!n)return l.NextResponse.json({error:"Preview could not be built"},{status:500});return l.NextResponse.json(n)}if("create"===t.action){let e=Array.isArray(t.proposals)?t.proposals:[];if(0===e.length)return l.NextResponse.json({error:"No proposed HedgeDocs selected"},{status:400});return l.NextResponse.json(await L(String(t.source??""),e))}return l.NextResponse.json({error:"Unknown action"},{status:400})}catch(e){return l.NextResponse.json({error:e instanceof Error?e.message:"Split operation failed"},{status:500})}}let z=new o.AppRouteRouteModule({definition:{kind:i.x.APP_ROUTE,page:"/memex-split-notes/route",pathname:"/memex-split-notes",filename:"route",bundlePath:"app/memex-split-notes/route"},resolvedPagePath:"/backups/builds/memex-source-summary-benchmark-yaml-build-20261020-135412-126600/frontend/src/app/memex-split-notes/route.ts",nextConfigOutput:"standalone",userland:n}),{requestAsyncStorage:q,staticGenerationAsyncStorage:F,serverHooks:K}=z,G="/memex-split-notes/route";function J(){return(0,a.patchFetch)({serverHooks:K,staticGenerationAsyncStorage:F})}},1608:(e,t,r)=>{r.d(t,{OQ:()=>g,fP:()=>h,iF:()=>y});var n=r(93977),o=r(49411);let i=process.env.MEMEX_MODEL_SETTINGS_PATH??"/data/projects/hedgedoc/memex/model-settings.json",a={provider:"llamacpp",baseUrl:"http://192.168.1.99:8080/v1",defaultModel:"/data/projects/llama.cpp/models/gemma4-26b-standalone.gguf",numCtx:65536,maxPromptChars:8e4,streamChatResponses:!0,llamacppCachePrompt:!0,timeoutSeconds:600,temperature:.35,ollamaFlashAttention:!0,ollamaKvCacheType:"q8_0"},s=/^[A-Za-z0-9_.:/@+\-]+$/,l=(e,t,r,n)=>{let o=Number(e);return!Number.isInteger(o)||o<r||o>n?t:o},c=(e,t,r,n)=>{let o=Number(e);return!Number.isFinite(o)||o<r||o>n?t:o},u=(e,t)=>"ollama"===e||"llamacpp"===e?e:t,f=(e,t)=>"boolean"==typeof e?e:t,d=(e,t)=>"f16"===e||"q8_0"===e||"q4_0"===e?e:t,p=(e,t)=>{if("string"!=typeof e)return t;let r=e.trim();return r&&!(r.length>160)&&s.test(r)?r:t},m=(e,t)=>{if("string"!=typeof e)return t;let r=e.trim().replace(/\/+$/,"");try{let e=new URL(r);if(!["http:","https:"].includes(e.protocol)||e.username||e.password)return t;return e.toString().replace(/\/$/,"")}catch{return t}},h=e=>{let t=e&&"object"==typeof e?e:{},r=u(t.provider,a.provider),n=f(t.ollamaFlashAttention,a.ollamaFlashAttention),o=d(t.ollamaKvCacheType,a.ollamaKvCacheType);return{provider:r,baseUrl:m(t.baseUrl,a.baseUrl),defaultModel:p(t.defaultModel,a.defaultModel),numCtx:l(t.numCtx,a.numCtx,1024,1048576),maxPromptChars:l(t.maxPromptChars,a.maxPromptChars,1e3,2e6),streamChatResponses:f(t.streamChatResponses,a.streamChatResponses),llamacppCachePrompt:f(t.llamacppCachePrompt,a.llamacppCachePrompt),timeoutSeconds:l(t.timeoutSeconds,a.timeoutSeconds,10,3600),temperature:c(t.temperature,a.temperature,0,2),ollamaFlashAttention:n,ollamaKvCacheType:n?o:"f16"}},g=async()=>{try{let e=await (0,n.readFile)(i,"utf8");return h(JSON.parse(e))}catch(e){if("ENOENT"===e.code)return a;throw e}},y=async e=>{let t=h(e),r=`${i}.tmp-${process.pid}-${Date.now()}`;await (0,n.mkdir)((0,o.dirname)(i),{recursive:!0}),await (0,n.writeFile)(r,`${JSON.stringify(t,null,2)}
`,"utf8"),await (0,n.rename)(r,i)}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),n=t.X(0,[9561,13472],()=>r(94969));module.exports=n})();