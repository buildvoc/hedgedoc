"use strict";(()=>{var e={};e.id=51504,e.ids=[51504],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},93977:e=>{e.exports=require("node:fs/promises")},49411:e=>{e.exports=require("node:path")},40019:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>J,patchFetch:()=>X,requestAsyncStorage:()=>D,routeModule:()=>F,serverHooks:()=>W,staticGenerationAsyncStorage:()=>K});var a={};r.r(a),r.d(a,{POST:()=>L,dynamic:()=>p,runtime:()=>c});var n=r(38708),o=r(63996),i=r(73831),s=r(16395),l=r(1608);let c="nodejs",p="force-dynamic",u=(process.env.MEMEX_WIKI_MAINTAIN_URL??"http://127.0.0.1:3101/memex-wiki-maintain").replace(/\/+$/,""),d=(process.env.MEMEX_WIKI_CONVERSATION_URL??"http://127.0.0.1:3101/memex-wiki-conversation").replace(/\/+$/,""),m=Math.max(2,Math.min(12,Number(process.env.MEMEX_WIKI_QUERY_MAX_PAGES??"8"))),h=Math.max(2,Math.min(12,Number(process.env.MEMEX_WIKI_QUERY_MAX_CHAT_TURNS??"8"))),f=e=>"object"==typeof e&&null!==e&&!Array.isArray(e),w=(e,t,r)=>{if("string"!=typeof e)throw Error(`${t} is required`);let a=e.trim();if(!a)throw Error(`${t} is required`);if(a.length>r)throw Error(`${t} is too long`);return a},y=e=>{let t="string"==typeof e?e.trim():"markdown";if("markdown"===t||"comparison"===t||"marp"===t||"matplotlib"===t||"canvas"===t)return t;throw Error("Unsupported query output format")},g=e=>{if(void 0===e)return[];if(!Array.isArray(e))throw Error("history must be an array");return e.flatMap(e=>{if(!f(e))return[];let t="user"===e.role||"assistant"===e.role?e.role:null,r="string"==typeof e.content?e.content.trim().slice(0,12e3):"";return t&&r?[{role:t,content:r}]:[]}).slice(-h)},v=e=>{if(!Array.isArray(e))throw Error("aliases must be an array");return[...new Set(e.filter(e=>"string"==typeof e).map(e=>e.trim()).filter(e=>/^memex-wiki-[A-Za-z0-9_-]{1,150}$/.test(e)))].slice(0,m)},E=async(e,t)=>{let r=await fetch(e,{...t,cache:"no-store"}),a=await r.json().catch(()=>null);if(!r.ok)throw Error(f(a)&&"string"==typeof a.error?a.error:`HTTP ${r.status} from ${e}`);if(!f(a))throw Error(`Invalid JSON response from ${e}`);return a},x=e=>{let t=[];for(let r of e.split(",")){let e=r.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);if(!e)continue;let a=Number(e[1]),n=e[2]?Number(e[2]):a;if(!(a<1)&&!(n<a)&&!(n-a>500))for(let e=a;e<=n;e+=1)t.push(e)}return t},T=e=>{let t=[],r=e.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]??"",a=r.match(/^memex_source_pages:\s*\[([^\]]*)\]\s*$/m)?.[1];for(let r of(a&&t.push(...x(a)),e.matchAll(/<!--\s*memex-source-pages:\s*([^>]+?)\s*-->/gi)))t.push(...x(r[1]));return[...new Set(t)].sort((e,t)=>e-t)},b=e=>{let t=e.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]??"",r=t.match(/^memex_source_anchor:\s*(.+?)\s*$/m)?.[1]?.trim();if(!r)return;let a=r.replace(/^(?:\"([^\"]*)\"|'([^']*)')$/,"$1$2").trim();return/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(a)?a:void 0},$=async e=>Promise.all(e.map(async e=>{if("source-summary"!==e.pageType)return e;try{let t=await E(`${u}?alias=${encodeURIComponent(e.alias)}`);if("string"!=typeof t.markdown)return e;let r=T(t.markdown),a=b(t.markdown);if(!r.length&&!a)return e;return{...e,...r.length?{sourcePages:r}:{},...a?{sourceAnchor:a}:{}}}catch{return e}})),k=async()=>{let e=await E(u);return(Array.isArray(e.pages)?e.pages:[]).flatMap(e=>{if(!f(e))return[];let t="string"==typeof e.alias?e.alias.trim():"",r="string"==typeof e.pageType?e.pageType.trim():"",a="string"==typeof e.title?e.title.trim():"",n="string"==typeof e.description?e.description.trim():"";return t.startsWith("memex-wiki-")&&r&&a?[{alias:t,pageType:r,title:a,description:n}]:[]})},S=e=>e.length?e.map(e=>`${"user"===e.role?"USER":"ASSISTANT"}:
${e.content}`).join("\n\n"):"(no earlier turns)",R=(e,t,r)=>{let a=[...new Set([...t.slice(-4).map(e=>e.content),e].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter(e=>e.length>=3))],n=r.map(e=>{let t=`${e.title} ${e.description} ${e.pageType} ${e.alias}`.toLowerCase(),r=a.reduce((e,r)=>e+(t.includes(r)?1:0),0);return{alias:e.alias,score:r}}).filter(e=>e.score>0).sort((e,t)=>t.score-e.score||e.alias.localeCompare(t.alias)).slice(0,m).map(e=>e.alias);return n.length?n:r.slice(0,m).map(e=>e.alias)},A=async e=>E(d,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e)}),M=async e=>{let t=await fetch(d,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...e,readOnly:!0,commit:!1,stream:!0}),cache:"no-store"});if(!t.ok){let e=await t.json().catch(()=>null);throw Error(f(e)&&"string"==typeof e.error?e.error:`HTTP ${t.status} from ${d}`)}if(!t.body)throw Error("Streaming Memex response has no body");return t},C=e=>{let t=e instanceof Error?e.message:String(e);return t.includes("Unexpected non-whitespace character after JSON")||t.includes("LLM answer is required")||t.includes("LLM conversation output must be a JSON object")||t.includes("Unexpected token")||t.includes("Invalid JSON")||t.includes("Read-only Memex response did not contain an answer")},N=async e=>{let t=async t=>{let r="string"==typeof e.conversation?e.conversation:"",a=await A({...e,readOnly:!0,commit:!1,conversation:t?`${r}

RETRY CONTRACT:
Return exactly one JSON object with one non-empty string field named "answer".
Do not append commentary before or after the JSON object.`:r});if("string"!=typeof a.answer||!a.answer.trim())throw Error("Read-only Memex response did not contain an answer");return a};try{return await t(!1)}catch(e){if(!C(e))throw e;return t(!0)}},q=(e,t,r)=>({aliases:R(e,t,r).sort((e,t)=>e.localeCompare(t)),retrieval:"lexical"}),O=e=>{switch(e){case"comparison":return`Return a concise Markdown comparison with a clear comparison table,
followed by the most important similarities, differences, and uncertainties.`;case"marp":return`Return a complete Marp slide deck as Markdown. Include the Marp
frontmatter and slide separators. Keep citations visible on the relevant slides.`;case"matplotlib":return`Return a short explanation followed by a complete Python matplotlib
code block that generates the requested chart from values actually supported by
the loaded wiki pages. Do not fabricate missing numeric data. Put citations and
data provenance outside the code block.`;case"canvas":return`Return a structured Markdown working canvas: question, key findings,
evidence, connections, uncertainties, and follow-up questions.`;default:return`Return a natural conversational Markdown answer. Follow the user's
requested style, including bullets when requested.`}},I=async(e,t,r,a)=>{let n=a.map(e=>`- ${e}`).join("\n"),o=`WIKI RAG ANSWER MODE.

You are answering a user in a chat interface using the maintained Memex wiki as
retrieval-augmented context. Use ONLY the FULL CURRENT PAGES loaded for this
request as factual wiki evidence. This call is server-enforced read-only.

RECENT CHAT
${S(t)}

LATEST QUESTION
${e}

Required output:
${O(r)}

Citation rules:
- Cite substantive claims inline with Markdown links to the exact loaded wiki page:
  [page title](/n/exact-memex-wiki-alias)
- Never cite a page that was not loaded.
- Do not invent citations, source aliases, facts, dates, relationships, or numbers.
- State uncertainty when the loaded pages do not support a definite answer.
- The loaded aliases available for citation are:
${n}
`;return N({provenance:`wiki-query-rag-answer ${new Date().toISOString()}`,targetAliases:a,conversation:o})},P=async(e,t,r,a)=>{let n=a.map(e=>`- ${e}`).join("\n"),o=`WIKI RAG ANSWER MODE.

You are answering a user in a chat interface using the maintained Memex wiki as
retrieval-augmented context. Use ONLY the FULL CURRENT PAGES loaded for this
request as factual wiki evidence. This call is server-enforced read-only.

RECENT CHAT
${S(t)}

LATEST QUESTION
${e}

Required output:
${O(r)}

Reference rules:
- The UI shows the loaded wiki pages separately as references, so do not add
  inline wiki citation links solely for attribution.
- Never rely on a page that was not loaded.
- Do not invent source aliases, facts, dates, relationships, or numbers.
- State uncertainty when the loaded pages do not support a definite answer.
- The loaded aliases available as evidence are:
${n}
`;return M({provenance:`wiki-query-rag-answer ${new Date().toISOString()}`,targetAliases:a,conversation:o})},U=(e,t)=>{if(!e.body)throw Error("Streaming Memex response has no body");let r=new TextEncoder,a=new TextDecoder,n=e.body;return new Response(new ReadableStream({async start(e){let o=n.getReader(),i=t=>{e.enqueue(r.encode(`${JSON.stringify(t)}
`))};i({type:"meta",...t});try{for(;;){let{value:e,done:t}=await o.read();if(t)break;let r=a.decode(e,{stream:!0});r&&i({type:"delta",delta:r})}let t=a.decode();t&&i({type:"delta",delta:t}),i({type:"done"}),e.close()}catch(t){i({type:"error",error:t instanceof Error?t.message:String(t)}),e.close()}finally{o.releaseLock()}}}),{headers:{"Cache-Control":"no-store","Content-Type":"application/x-ndjson; charset=utf-8","X-Accel-Buffering":"no"}})},_=(e,t)=>{let r=e;for(let e of t){let t=e.title.trim(),a=e.alias.trim();if(!a)continue;let n=e=>e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),o=n(a),i=t?n(t):"";r=(r=(r=r.replace(RegExp(`\\s*\\[[^\\]\\n]+\\]\\(\\/(?:n\\/)?${o}\\)`,"g"),"")).replace(RegExp(`\\s*\\[\\[${o}\\]\\]`,"g"),"")).replace(RegExp(`\\s*\\[${o}\\](?!\\()`,"g"),""),i&&(r=(r=r.replace(RegExp(`\\s*\\[\\[${i}\\]\\]`,"g"),"")).replace(RegExp(`\\s*\\[${i}\\](?!\\()`,"g"),""))}return r.replace(/[ \t]+([,.;:!?])/g,"$1").replace(/([,.;:!?])(?=[A-Za-z0-9])/g,"$1 ").replace(/[ \t]{2,}/g," ")},j=async(e,t,r,a)=>{if(0===a.length)throw Error("Cannot file an answer without supporting wiki pages");let n=a.map(e=>`- ${e}`).join("\n"),o="comparison"===r?"comparison":"synthesis",i=`FILE A QUERY ANSWER INTO THE PERSISTENT MEMEX WIKI.

Create exactly ONE durable ${o} page from the query and answer below.
This is a filing operation, not a new research step.

Question:
${e}

Answer to file:
${t}

Rules:
- pageType must be "${o}".
- For a NEW page, omit alias entirely.
- Do not edit source-summary, entity, or topic pages.
- sourceAliases MUST contain one or more exact loaded derived aliases from:
${n}
- Never copy opaque raw HedgeDoc aliases from YAML. The server will expand the
  loaded memex-wiki-* aliases to canonical raw evidence.
- Preserve the useful citations from the answer.
- Do not add claims not already supported by the loaded pages.
- Proofread the title.
- If the answer is a Marp deck, store it inside a fenced Markdown code block so
  the page body does not begin with YAML frontmatter.
- If the answer is matplotlib code, retain the code and its evidence/citation notes.
- Return exactly one page mutation.
`,s=await A({commit:!1,provenance:`wiki-query-file ${new Date().toISOString()}`,targetAliases:a,conversation:i}),l=Array.isArray(s.pages)?s.pages:[];if(0===l.length)return{...s,noChange:!0,answer:"string"==typeof s.answer&&s.answer.trim()?s.answer:"No durable wiki page was proposed for this answer.",pages:[]};if(1!==l.length||!f(l[0]))throw Error("Filing preview may contain at most one wiki page");let c="string"==typeof l[0].pageType?l[0].pageType:"";if(c!==o)throw Error(`Filing preview returned unexpected pageType: ${c}`);if(0===(Array.isArray(l[0].sourceAliases)?l[0].sourceAliases.filter(e=>"string"==typeof e&&e.trim().length>0):[]).length)throw Error("Refusing filing preview with empty canonical evidence");return s};async function L(e){try{let t=await e.json(),r="string"==typeof t.action?t.action.trim():"query";if("commit"===r){let e=w(t.previewToken,"previewToken",500),r=await A({commit:!0,previewToken:e});return s.NextResponse.json(r,{headers:{"Cache-Control":"no-store"}})}let a=w(t.question,"question",12e3),n=g(t.history),o=y(t.format);if("file-preview"===r){let e=w(t.answer,"answer",5e4),r=v(t.aliases),n=await j(a,e,o,r);return s.NextResponse.json(n,{headers:{"Cache-Control":"no-store"}})}if("query"!==r)throw Error("Unsupported query action");let i=await k();if(0===i.length)throw Error("The maintained Memex wiki catalogue is empty");let c=q(a,n,i),p=c.aliases,u=new Map(i.map(e=>[e.alias,e])),d=await $(p.flatMap(e=>{let t=u.get(e);return t?[t]:[]})),m=await (0,l.OQ)();if(m.streamChatResponses){let e=await P(a,n,o,p);return U(e,{format:o,aliases:p,pages:d,readOnly:!0,model:m.defaultModel,provider:m.provider,retrieval:c.retrieval})}let h=await I(a,n,o,p),f="string"==typeof h.answer?h.answer:"The query returned no answer.",E=_(f,d);return s.NextResponse.json({answer:E,format:o,aliases:p,pages:d,readOnly:!0===h.readOnly,model:h.model,provider:h.provider,retrieval:c.retrieval},{headers:{"Cache-Control":"no-store"}})}catch(t){let e=t instanceof Error?t.message:"Memex wiki query failed";return s.NextResponse.json({error:e},{status:500})}}let F=new n.AppRouteRouteModule({definition:{kind:o.x.APP_ROUTE,page:"/memex-wiki-query/route",pathname:"/memex-wiki-query",filename:"route",bundlePath:"app/memex-wiki-query/route"},resolvedPagePath:"/backups/builds/memex-wiki-summary-one-shot-build-20261020-155222-132926/frontend/src/app/memex-wiki-query/route.ts",nextConfigOutput:"standalone",userland:a}),{requestAsyncStorage:D,staticGenerationAsyncStorage:K,serverHooks:W}=F,J="/memex-wiki-query/route";function X(){return(0,i.patchFetch)({serverHooks:W,staticGenerationAsyncStorage:K})}},1608:(e,t,r)=>{r.d(t,{OQ:()=>w,fP:()=>f,iF:()=>y});var a=r(93977),n=r(49411);let o=process.env.MEMEX_MODEL_SETTINGS_PATH??"/data/projects/hedgedoc/memex/model-settings.json",i={provider:"llamacpp",baseUrl:"http://192.168.1.99:8080/v1",defaultModel:"/data/projects/llama.cpp/models/gemma4-26b-standalone.gguf",numCtx:65536,maxPromptChars:8e4,streamChatResponses:!0,llamacppCachePrompt:!0,timeoutSeconds:600,temperature:.35,ollamaFlashAttention:!0,ollamaKvCacheType:"q8_0"},s=/^[A-Za-z0-9_.:/@+\-]+$/,l=(e,t,r,a)=>{let n=Number(e);return!Number.isInteger(n)||n<r||n>a?t:n},c=(e,t,r,a)=>{let n=Number(e);return!Number.isFinite(n)||n<r||n>a?t:n},p=(e,t)=>"ollama"===e||"llamacpp"===e?e:t,u=(e,t)=>"boolean"==typeof e?e:t,d=(e,t)=>"f16"===e||"q8_0"===e||"q4_0"===e?e:t,m=(e,t)=>{if("string"!=typeof e)return t;let r=e.trim();return r&&!(r.length>160)&&s.test(r)?r:t},h=(e,t)=>{if("string"!=typeof e)return t;let r=e.trim().replace(/\/+$/,"");try{let e=new URL(r);if(!["http:","https:"].includes(e.protocol)||e.username||e.password)return t;return e.toString().replace(/\/$/,"")}catch{return t}},f=e=>{let t=e&&"object"==typeof e?e:{},r=p(t.provider,i.provider),a=u(t.ollamaFlashAttention,i.ollamaFlashAttention),n=d(t.ollamaKvCacheType,i.ollamaKvCacheType);return{provider:r,baseUrl:h(t.baseUrl,i.baseUrl),defaultModel:m(t.defaultModel,i.defaultModel),numCtx:l(t.numCtx,i.numCtx,1024,1048576),maxPromptChars:l(t.maxPromptChars,i.maxPromptChars,1e3,2e6),streamChatResponses:u(t.streamChatResponses,i.streamChatResponses),llamacppCachePrompt:u(t.llamacppCachePrompt,i.llamacppCachePrompt),timeoutSeconds:l(t.timeoutSeconds,i.timeoutSeconds,10,3600),temperature:c(t.temperature,i.temperature,0,2),ollamaFlashAttention:a,ollamaKvCacheType:a?n:"f16"}},w=async()=>{try{let e=await (0,a.readFile)(o,"utf8");return f(JSON.parse(e))}catch(e){if("ENOENT"===e.code)return i;throw e}},y=async e=>{let t=f(e),r=`${o}.tmp-${process.pid}-${Date.now()}`;await (0,a.mkdir)((0,n.dirname)(o),{recursive:!0}),await (0,a.writeFile)(r,`${JSON.stringify(t,null,2)}
`,"utf8"),await (0,a.rename)(r,o)}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),a=t.X(0,[9561,13472],()=>r(40019));module.exports=a})();