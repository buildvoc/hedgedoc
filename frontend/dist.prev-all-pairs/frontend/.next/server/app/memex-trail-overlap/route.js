"use strict";(()=>{var e={};e.id=62262,e.ids=[62262],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},78446:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>A,patchFetch:()=>E,requestAsyncStorage:()=>w,routeModule:()=>g,serverHooks:()=>x,staticGenerationAsyncStorage:()=>b});var n={};r.r(n),r.d(n,{POST:()=>y,dynamic:()=>l});var i=r(38708),a=r(63996),o=r(73831),s=r(16395);let l="force-dynamic",c=new Set(["distinct","partial_overlap","strong_overlap","duplicate"]);function u(e,t=""){return"string"==typeof e?e.trim():t}function d(e){let t;if("number"==typeof e)t=e;else if("string"==typeof e){let r=e.trim();if(!r)return null;let n=r.match(/-?\d+(?:\.\d+)?/);if(!n||!Number.isFinite(t=Number(n[0])))return null;(/%|\bpercent\b/i.test(r)||t>1)&&(t/=100)}else{if(null==e||!Number.isFinite(t=Number(e)))return null;t>1&&(t/=100)}return Math.max(0,Math.min(1,t))}function m(e){if(!e||"object"!=typeof e)return null;let t=u(e.alias);return t?{alias:t,title:u(e.title)||void 0}:null}function p(e){if(!e||"object"!=typeof e)return null;let t=u(e.id),r=u(e.name);if(!t||!r)return null;let n=Array.isArray(e.members)?e.members.map(m).filter(e=>null!==e):[];return{id:t,name:r,reason:u(e.reason)||void 0,origin:u(e.origin)||void 0,status:u(e.status)||void 0,members:n}}function f(e){let t=u(e).toLowerCase();return c.has(t)?t:"distinct"}function h(e){return u(e).replace(/\s+/g," ").toLowerCase()}function v(e,t){let r=u(e);if(!r)return null;let n=t.find(e=>e.id===r);if(n)return n;let i=h(r);return t.find(e=>h(e.name)===i)??t.find(e=>h(e.id)===i)??null}async function y(e){try{var t;let r=await e.json(),n=(Array.isArray(r.trails)?r.trails:[]).map(p).filter(e=>null!==e),i=[...new Map(n.map(e=>[e.id,e])).values()];if(i.length<2)return s.NextResponse.json({error:"Select at least two valid trails for overlap review."},{status:400});let a=function(e){let t=[];for(let r=0;r<e.length;r+=1)for(let n=r+1;n<e.length;n+=1)t.push(function(e,t){let r=new Set(e.members.map(e=>e.alias)),n=new Set(t.members.map(e=>e.alias)),i=[...r].filter(e=>n.has(e)).sort((e,t)=>e.localeCompare(t)),a=new Set([...r,...n]),o=0===a.size?0:i.length/a.size;return{trailIds:[e.id,t.id],sharedMemberAliases:i,sharedMembers:i.length,unionMembers:a.size,jaccard:Number(o.toFixed(4))}}(e[r],e[n]));return t}(i),o=`You are reviewing selected Memex trails for semantic overlap.

This is a READ-ONLY review. Do not merge, rename, edit, or delete anything.

Classify overlap by the conceptual traversal a user would expect:
- intent / question the trail helps answer
- scope and subject boundary
- action or traversal purpose
- context
- expected outcome

Important:
- Similar wording is NOT enough to call two trails duplicates.
- Sharing the same place, broad topic, category, chronology, title words, or keywords is NOT enough.
- Shared source members are useful structural evidence but are NOT by themselves proof of semantic duplication.
- "duplicate" means one trail can replace the other with minimal conceptual loss.
- "strong_overlap" means substantial redundancy remains, but there is still a meaningful distinction.
- "partial_overlap" means they intersect but have clearly complementary purposes or scopes.
- "distinct" means the conceptual traversal/purpose is materially different.
- Do not auto-merge. Recommendations may say keep separate, rename for clarity, narrow one trail, or consider a manual merge.
- Prefer preserving useful distinctions.
- In every pairwise item, trailIds MUST contain the exact selected trail id values from SELECTED TRAILS. Never put a trail name in trailIds.
- Every confidence value MUST be a JSON number from 0.0 to 1.0 (for example 0.90), never 90 and never "90%".

Return JSON only, exactly in this shape:
{
  "classification": "distinct|partial_overlap|strong_overlap|duplicate",
  "confidence": 0.0,
  "summary": "overall review",
  "recommendation": "read-only recommendation",
  "distinctions": ["important distinction"],
  "pairwise": [
    {
      "trailIds": ["id-a", "id-b"],
      "classification": "distinct|partial_overlap|strong_overlap|duplicate",
      "confidence": 0.0,
      "overlap": "what actually overlaps",
      "distinction": "what remains different",
      "recommendation": "what a human curator should consider"
    }
  ]
}

SELECTED TRAILS:
${JSON.stringify(i,null,2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(a,null,2)}
`,l=process.env.MEMEX_OLLAMA_URL??process.env.OLLAMA_URL??"http://192.168.1.99:11434",c=process.env.MEMEX_OLLAMA_MODEL??process.env.OLLAMA_MODEL??"gemma4:26b",m=await fetch(`${l.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({model:c,messages:[{role:"user",content:o}],stream:!1,format:"json",options:{temperature:.1,num_ctx:32768}})});if(!m.ok){let e=(await m.text()).slice(0,1e3);throw Error(`Ollama returned ${m.status}: ${e}`)}let h=await m.json(),y=h.message&&"object"==typeof h.message?h.message:{},g=u(y.content),w=function(e){let t=e.trim();if(!t)throw Error("LLM returned an empty response");try{let e=JSON.parse(t);if(e&&"object"==typeof e&&!Array.isArray(e))return e}catch{}let r=e.indexOf("{"),n=e.lastIndexOf("}");if(r<0||n<=r)throw Error("LLM response did not contain a JSON object");let i=JSON.parse(e.slice(r,n+1));if(!i||"object"!=typeof i||Array.isArray(i))throw Error("LLM response JSON was not an object");return i}(g),b=d(w.confidence);return s.NextResponse.json({ok:!0,readOnly:!0,model:c,selectedTrailCount:i.length,deterministicEvidence:a,review:{classification:f(w.classification),confidence:b??0,summary:u(w.summary),recommendation:u(w.recommendation),distinctions:(t=w.distinctions,Array.isArray(t)?t.map(e=>u(e)).filter(Boolean):[]),pairwise:function(e,t,r){if(!Array.isArray(e))return[];let n=new Set;return e.map(e=>{if(!e||"object"!=typeof e)return null;let i=Array.isArray(e.trailIds)?e.trailIds.slice(0,2):[];if(2!==i.length)return null;let a=v(i[0],t),o=v(i[1],t);if(!a||!o||a.id===o.id)return null;let s=[a.id,o.id].sort().join("::");return n.has(s)?null:(n.add(s),{trailIds:[a.id,o.id],trailNames:[a.name,o.name],classification:f(e.classification),confidence:d(e.confidence)??(2===t.length?r:null)??0,overlap:u(e.overlap),distinction:u(e.distinction),recommendation:u(e.recommendation)})}).filter(Boolean)}(w.pairwise,i,2===i.length?b:null)}})}catch(e){return console.error("Memex trail overlap review failed",e),s.NextResponse.json({error:e instanceof Error?e.message:"Unknown Memex trail overlap review error"},{status:500})}}let g=new i.AppRouteRouteModule({definition:{kind:a.x.APP_ROUTE,page:"/memex-trail-overlap/route",pathname:"/memex-trail-overlap",filename:"route",bundlePath:"app/memex-trail-overlap/route"},resolvedPagePath:"/home/hp/hedgedoc-build-overlap/frontend/src/app/memex-trail-overlap/route.ts",nextConfigOutput:"standalone",userland:n}),{requestAsyncStorage:w,staticGenerationAsyncStorage:b,serverHooks:x}=g,A="/memex-trail-overlap/route";function E(){return(0,o.patchFetch)({serverHooks:x,staticGenerationAsyncStorage:b})}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),n=t.X(0,[9561,13472],()=>r(78446));module.exports=n})();