"use strict";(()=>{var e={};e.id=62262,e.ids=[62262],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},78446:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>M,patchFetch:()=>A,requestAsyncStorage:()=>x,routeModule:()=>b,serverHooks:()=>R,staticGenerationAsyncStorage:()=>I});var i={};r.r(i),r.d(i,{POST:()=>S,dynamic:()=>l});var a=r(38708),n=r(63996),o=r(73831),s=r(16395);let l="force-dynamic",c=new Set(["distinct","partial_overlap","strong_overlap","duplicate"]);function u(e,t=""){return"string"==typeof e?e.trim():t}function d(e){let t;if("number"==typeof e)t=e;else if("string"==typeof e){let r=e.trim();if(!r)return null;let i=r.match(/-?\d+(?:\.\d+)?/);if(!i||!Number.isFinite(t=Number(i[0])))return null;(/%|\bpercent\b/i.test(r)||t>1)&&(t/=100)}else{if(null==e||!Number.isFinite(t=Number(e)))return null;t>1&&(t/=100)}return Math.max(0,Math.min(1,t))}function p(e){if(!e||"object"!=typeof e)return null;let t=u(e.alias);return t?{alias:t,title:u(e.title)||void 0}:null}function m(e){if(!e||"object"!=typeof e)return null;let t=u(e.id),r=u(e.name);if(!t||!r)return null;let i=Array.isArray(e.members)?e.members.map(p).filter(e=>null!==e):[];return{id:t,name:r,reason:u(e.reason)||void 0,origin:u(e.origin)||void 0,status:u(e.status)||void 0,members:i}}function f(e){let t=u(e).toLowerCase();return c.has(t)?t:"distinct"}function h(e){return u(e).replace(/\s+/g," ").toLowerCase()}function v(e,t){let r=u(e);if(!r)return null;let i=t.find(e=>e.id===r);if(i)return i;let a=h(r);return t.find(e=>h(e.name)===a)??t.find(e=>h(e.id)===a)??null}function y(e){return[...e].sort().join("::")}function w(e,t,r){if(!Array.isArray(e))return[];let i=new Set;return e.map(e=>{if(!e||"object"!=typeof e)return null;let a=Array.isArray(e.trailIds)?e.trailIds.slice(0,2):[];if(2!==a.length)return null;let n=v(a[0],t),o=v(a[1],t);if(!n||!o||n.id===o.id)return null;let s=y([n.id,o.id]);return i.has(s)?null:(i.add(s),{trailIds:[n.id,o.id],trailNames:[n.name,o.name],classification:f(e.classification),confidence:d(e.confidence)??(2===t.length?r:null)??0,overlap:u(e.overlap),distinction:u(e.distinction),recommendation:u(e.recommendation)})}).filter(e=>null!==e)}async function g(e,t,r){let i=await fetch(`${e.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({model:t,messages:[{role:"user",content:r}],stream:!1,format:"json",options:{temperature:.1,num_ctx:32768}})});if(!i.ok){let e=(await i.text()).slice(0,1e3);throw Error(`Ollama returned ${i.status}: ${e}`)}let a=await i.json();return function(e){let t=e.trim();if(!t)throw Error("LLM returned an empty response");try{let e=JSON.parse(t);if(e&&"object"==typeof e&&!Array.isArray(e))return e}catch{}let r=e.indexOf("{"),i=e.lastIndexOf("}");if(r<0||i<=r)throw Error("LLM response did not contain a JSON object");let a=JSON.parse(e.slice(r,i+1));if(!a||"object"!=typeof a||Array.isArray(a))throw Error("LLM response JSON was not an object");return a}(u((a.message&&"object"==typeof a.message?a.message:{}).content))}function E(e,t){let r=new Map(t.map(e=>[e.id,e]));return e.map((e,t)=>{let i=r.get(e.trailIds[0]),a=r.get(e.trailIds[1]);return`${t+1}. ${e.trailIds[0]} (${i?.name??"Selected trail"}) <-> ${e.trailIds[1]} (${a?.name??"Selected trail"})`}).join("\n")}async function S(e){try{var t;let r=await e.json(),i=(Array.isArray(r.trails)?r.trails:[]).map(m).filter(e=>null!==e),a=[...new Map(i.map(e=>[e.id,e])).values()];if(a.length<2)return s.NextResponse.json({error:"Select at least two valid trails for overlap review."},{status:400});let n=function(e){let t=[];for(let r=0;r<e.length;r+=1)for(let i=r+1;i<e.length;i+=1)t.push(function(e,t){let r=new Set(e.members.map(e=>e.alias)),i=new Set(t.members.map(e=>e.alias)),a=[...r].filter(e=>i.has(e)).sort((e,t)=>e.localeCompare(t)),n=new Set([...r,...i]),o=0===n.size?0:a.length/n.size;return{trailIds:[e.id,t.id],sharedMemberAliases:a,sharedMembers:a.length,unionMembers:n.size,jaccard:Number(o.toFixed(4))}}(e[r],e[i]));return t}(a),o=n.length,l=`You are reviewing selected Memex trails for semantic overlap.

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
- In every pairwise item, trailIds MUST contain the exact selected trail id values from REQUIRED PAIRS. Never put a trail name in trailIds.
- Every confidence value MUST be a JSON number from 0.0 to 1.0 (for example 0.90), never 90 and never "90%".
- You MUST review EVERY unique selected-trail pair exactly once.
- ${a.length} selected trails produce exactly ${o} unique pairs.
- Therefore pairwise MUST contain exactly ${o} items. Do not omit pairs and do not add extra pairs.

Return JSON only, exactly in this shape:
{
  "classification": "distinct|partial_overlap|strong_overlap|duplicate",
  "confidence": 0.0,
  "summary": "overall review",
  "recommendation": "read-only recommendation",
  "distinctions": ["important distinction"],
  "pairwise": [
    {
      "trailIds": ["exact-id-a", "exact-id-b"],
      "classification": "distinct|partial_overlap|strong_overlap|duplicate",
      "confidence": 0.0,
      "overlap": "what actually overlaps",
      "distinction": "what remains different",
      "recommendation": "what a human curator should consider"
    }
  ]
}

REQUIRED PAIRS (${o}):
${E(n,a)}

SELECTED TRAILS:
${JSON.stringify(a,null,2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(n,null,2)}
`,c=process.env.MEMEX_OLLAMA_URL??process.env.OLLAMA_URL??"http://192.168.1.99:11434",p=process.env.MEMEX_OLLAMA_MODEL??process.env.OLLAMA_MODEL??"gemma4:26b",h=await g(c,p,l),v=d(h.confidence),S=new Map;for(let e of w(h.pairwise,a,2===a.length?v:null))S.set(y(e.trailIds),e);let b=0;for(;S.size<o&&b<3;){let e=n.filter(e=>!S.has(y(e.trailIds)));if(0===e.length)break;b+=1;let t=await g(c,p,function(e,t){let r=new Set(e.flatMap(e=>e.trailIds)),i=t.filter(e=>r.has(e.id));return`You are completing a Memex trail overlap review that was missing pairwise results.

This is READ-ONLY. Do not merge, rename, edit, or delete trails.

Return one pairwise review for EVERY REQUIRED PAIR below. Do not omit any pair and do not add extra pairs.
There are exactly ${e.length} required pair(s), so pairwise MUST contain exactly ${e.length} item(s).

Use these classifications only: distinct, partial_overlap, strong_overlap, duplicate.
Every confidence MUST be a JSON number from 0.0 to 1.0.
In trailIds, use the exact ids shown in REQUIRED PAIRS.

Return JSON only:
{
  "pairwise": [
    {
      "trailIds": ["exact-id-a", "exact-id-b"],
      "classification": "distinct|partial_overlap|strong_overlap|duplicate",
      "confidence": 0.0,
      "overlap": "what actually overlaps",
      "distinction": "what remains different",
      "recommendation": "what a human curator should consider"
    }
  ]
}

REQUIRED PAIRS (${e.length}):
${E(e,t)}

TRAILS NEEDED FOR THESE PAIRS:
${JSON.stringify(i,null,2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(e,null,2)}
`}(e,a));for(let r of w(t.pairwise,a,null)){let t=y(r.trailIds);e.some(e=>y(e.trailIds)===t)&&S.set(t,r)}}if(n.filter(e=>!S.has(y(e.trailIds))).length>0)throw Error(`LLM returned an incomplete pairwise review: ${S.size}/${o} pairs after ${b} repair call(s). No partial review was returned.`);let x=n.map(e=>S.get(y(e.trailIds)));return s.NextResponse.json({ok:!0,readOnly:!0,model:p,selectedTrailCount:a.length,expectedPairCount:o,reviewedPairCount:x.length,repairCalls:b,deterministicEvidence:n,review:{classification:f(h.classification),confidence:v??0,summary:u(h.summary),recommendation:u(h.recommendation),distinctions:(t=h.distinctions,Array.isArray(t)?t.map(e=>u(e)).filter(Boolean):[]),pairwise:x}})}catch(e){return console.error("Memex trail overlap review failed",e),s.NextResponse.json({error:e instanceof Error?e.message:"Unknown Memex trail overlap review error"},{status:500})}}let b=new a.AppRouteRouteModule({definition:{kind:n.x.APP_ROUTE,page:"/memex-trail-overlap/route",pathname:"/memex-trail-overlap",filename:"route",bundlePath:"app/memex-trail-overlap/route"},resolvedPagePath:"/home/hp/hedgedoc-build-overlap/frontend/src/app/memex-trail-overlap/route.ts",nextConfigOutput:"standalone",userland:i}),{requestAsyncStorage:x,staticGenerationAsyncStorage:I,serverHooks:R}=b,M="/memex-trail-overlap/route";function A(){return(0,o.patchFetch)({serverHooks:R,staticGenerationAsyncStorage:I})}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),i=t.X(0,[9561,13472],()=>r(78446));module.exports=i})();