"use strict";(()=>{var e={};e.id=62262,e.ids=[62262],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},78446:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>A,patchFetch:()=>E,requestAsyncStorage:()=>w,routeModule:()=>g,serverHooks:()=>x,staticGenerationAsyncStorage:()=>b});var a={};r.r(a),r.d(a,{POST:()=>y,dynamic:()=>l});var n=r(38708),i=r(63996),o=r(73831),s=r(16395);let l="force-dynamic",c=new Set(["distinct","partial_overlap","strong_overlap","duplicate"]);function u(e,t=""){return"string"==typeof e?e.trim():t}function d(e){let t="number"==typeof e?e:Number(e);return Number.isFinite(t)?Math.max(0,Math.min(1,t)):0}function p(e){if(!e||"object"!=typeof e)return null;let t=u(e.alias);return t?{alias:t,title:u(e.title)||void 0}:null}function m(e){if(!e||"object"!=typeof e)return null;let t=u(e.id),r=u(e.name);if(!t||!r)return null;let a=Array.isArray(e.members)?e.members.map(p).filter(e=>null!==e):[];return{id:t,name:r,reason:u(e.reason)||void 0,origin:u(e.origin)||void 0,status:u(e.status)||void 0,members:a}}function f(e){let t=u(e).toLowerCase();return c.has(t)?t:"distinct"}function h(e){return u(e).replace(/\s+/g," ").toLowerCase()}function v(e,t){let r=u(e);if(!r)return null;let a=t.find(e=>e.id===r);if(a)return a;let n=h(r);return t.find(e=>h(e.name)===n)??t.find(e=>h(e.id)===n)??null}async function y(e){try{var t;let r=await e.json(),a=(Array.isArray(r.trails)?r.trails:[]).map(m).filter(e=>null!==e),n=[...new Map(a.map(e=>[e.id,e])).values()];if(n.length<2)return s.NextResponse.json({error:"Select at least two valid trails for overlap review."},{status:400});let i=function(e){let t=[];for(let r=0;r<e.length;r+=1)for(let a=r+1;a<e.length;a+=1)t.push(function(e,t){let r=new Set(e.members.map(e=>e.alias)),a=new Set(t.members.map(e=>e.alias)),n=[...r].filter(e=>a.has(e)).sort((e,t)=>e.localeCompare(t)),i=new Set([...r,...a]),o=0===i.size?0:n.length/i.size;return{trailIds:[e.id,t.id],sharedMemberAliases:n,sharedMembers:n.length,unionMembers:i.size,jaccard:Number(o.toFixed(4))}}(e[r],e[a]));return t}(n),o=`You are reviewing selected Memex trails for semantic overlap.

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
${JSON.stringify(n,null,2)}

DETERMINISTIC MEMBER-OVERLAP EVIDENCE:
${JSON.stringify(i,null,2)}
`,l=process.env.MEMEX_OLLAMA_URL??process.env.OLLAMA_URL??"http://192.168.1.99:11434",c=process.env.MEMEX_OLLAMA_MODEL??process.env.OLLAMA_MODEL??"gemma4:26b",p=await fetch(`${l.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({model:c,messages:[{role:"user",content:o}],stream:!1,format:"json",options:{temperature:.1,num_ctx:32768}})});if(!p.ok){let e=(await p.text()).slice(0,1e3);throw Error(`Ollama returned ${p.status}: ${e}`)}let h=await p.json(),y=h.message&&"object"==typeof h.message?h.message:{},g=u(y.content),w=function(e){let t=e.trim();if(!t)throw Error("LLM returned an empty response");try{let e=JSON.parse(t);if(e&&"object"==typeof e&&!Array.isArray(e))return e}catch{}let r=e.indexOf("{"),a=e.lastIndexOf("}");if(r<0||a<=r)throw Error("LLM response did not contain a JSON object");let n=JSON.parse(e.slice(r,a+1));if(!n||"object"!=typeof n||Array.isArray(n))throw Error("LLM response JSON was not an object");return n}(g);return s.NextResponse.json({ok:!0,readOnly:!0,model:c,selectedTrailCount:n.length,deterministicEvidence:i,review:{classification:f(w.classification),confidence:d(w.confidence),summary:u(w.summary),recommendation:u(w.recommendation),distinctions:(t=w.distinctions,Array.isArray(t)?t.map(e=>u(e)).filter(Boolean):[]),pairwise:function(e,t){if(!Array.isArray(e))return[];let r=new Set;return e.map(e=>{if(!e||"object"!=typeof e)return null;let a=Array.isArray(e.trailIds)?e.trailIds.slice(0,2):[];if(2!==a.length)return null;let n=v(a[0],t),i=v(a[1],t);if(!n||!i||n.id===i.id)return null;let o=[n.id,i.id].sort().join("::");return r.has(o)?null:(r.add(o),{trailIds:[n.id,i.id],trailNames:[n.name,i.name],classification:f(e.classification),confidence:d(e.confidence),overlap:u(e.overlap),distinction:u(e.distinction),recommendation:u(e.recommendation)})}).filter(Boolean)}(w.pairwise,n)}})}catch(e){return console.error("Memex trail overlap review failed",e),s.NextResponse.json({error:e instanceof Error?e.message:"Unknown Memex trail overlap review error"},{status:500})}}let g=new n.AppRouteRouteModule({definition:{kind:i.x.APP_ROUTE,page:"/memex-trail-overlap/route",pathname:"/memex-trail-overlap",filename:"route",bundlePath:"app/memex-trail-overlap/route"},resolvedPagePath:"/home/hp/hedgedoc-build-overlap/frontend/src/app/memex-trail-overlap/route.ts",nextConfigOutput:"standalone",userland:a}),{requestAsyncStorage:w,staticGenerationAsyncStorage:b,serverHooks:x}=g,A="/memex-trail-overlap/route";function E(){return(0,o.patchFetch)({serverHooks:x,staticGenerationAsyncStorage:b})}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),a=t.X(0,[9561,13472],()=>r(78446));module.exports=a})();