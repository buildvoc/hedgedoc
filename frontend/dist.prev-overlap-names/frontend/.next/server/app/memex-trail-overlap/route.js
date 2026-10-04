"use strict";(()=>{var e={};e.id=62262,e.ids=[62262],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},78446:(e,t,r)=>{r.r(t),r.d(t,{originalPathname:()=>b,patchFetch:()=>x,requestAsyncStorage:()=>y,routeModule:()=>v,serverHooks:()=>w,staticGenerationAsyncStorage:()=>g});var a={};r.r(a),r.d(a,{POST:()=>h,dynamic:()=>l});var n=r(38708),i=r(63996),o=r(73831),s=r(16395);let l="force-dynamic",c=new Set(["distinct","partial_overlap","strong_overlap","duplicate"]);function p(e,t=""){return"string"==typeof e?e.trim():t}function u(e){let t="number"==typeof e?e:Number(e);return Number.isFinite(t)?Math.max(0,Math.min(1,t)):0}function m(e){if(!e||"object"!=typeof e)return null;let t=p(e.alias);return t?{alias:t,title:p(e.title)||void 0}:null}function d(e){if(!e||"object"!=typeof e)return null;let t=p(e.id),r=p(e.name);if(!t||!r)return null;let a=Array.isArray(e.members)?e.members.map(m).filter(e=>null!==e):[];return{id:t,name:r,reason:p(e.reason)||void 0,origin:p(e.origin)||void 0,status:p(e.status)||void 0,members:a}}function f(e){let t=p(e).toLowerCase();return c.has(t)?t:"distinct"}async function h(e){try{var t,r;let a=await e.json(),n=(Array.isArray(a.trails)?a.trails:[]).map(d).filter(e=>null!==e),i=[...new Map(n.map(e=>[e.id,e])).values()];if(i.length<2)return s.NextResponse.json({error:"Select at least two valid trails for overlap review."},{status:400});let o=function(e){let t=[];for(let r=0;r<e.length;r+=1)for(let a=r+1;a<e.length;a+=1)t.push(function(e,t){let r=new Set(e.members.map(e=>e.alias)),a=new Set(t.members.map(e=>e.alias)),n=[...r].filter(e=>a.has(e)).sort((e,t)=>e.localeCompare(t)),i=new Set([...r,...a]),o=0===i.size?0:n.length/i.size;return{trailIds:[e.id,t.id],sharedMemberAliases:n,sharedMembers:n.length,unionMembers:i.size,jaccard:Number(o.toFixed(4))}}(e[r],e[a]));return t}(i),l=`You are reviewing selected Memex trails for semantic overlap.

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
${JSON.stringify(o,null,2)}
`,c=process.env.MEMEX_OLLAMA_URL??process.env.OLLAMA_URL??"http://192.168.1.99:11434",m=process.env.MEMEX_OLLAMA_MODEL??process.env.OLLAMA_MODEL??"gemma4:26b",h=await fetch(`${c.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({model:m,messages:[{role:"user",content:l}],stream:!1,format:"json",options:{temperature:.1,num_ctx:32768}})});if(!h.ok){let e=(await h.text()).slice(0,1e3);throw Error(`Ollama returned ${h.status}: ${e}`)}let v=await h.json(),y=v.message&&"object"==typeof v.message?v.message:{},g=p(y.content),w=function(e){let t=e.trim();if(!t)throw Error("LLM returned an empty response");try{let e=JSON.parse(t);if(e&&"object"==typeof e&&!Array.isArray(e))return e}catch{}let r=e.indexOf("{"),a=e.lastIndexOf("}");if(r<0||a<=r)throw Error("LLM response did not contain a JSON object");let n=JSON.parse(e.slice(r,a+1));if(!n||"object"!=typeof n||Array.isArray(n))throw Error("LLM response JSON was not an object");return n}(g);return s.NextResponse.json({ok:!0,readOnly:!0,model:m,selectedTrailCount:i.length,deterministicEvidence:o,review:{classification:f(w.classification),confidence:u(w.confidence),summary:p(w.summary),recommendation:p(w.recommendation),distinctions:(t=w.distinctions,Array.isArray(t)?t.map(e=>p(e)).filter(Boolean):[]),pairwise:(r=w.pairwise,Array.isArray(r)?r.map(e=>{if(!e||"object"!=typeof e)return null;let t=Array.isArray(e.trailIds)?e.trailIds.map(e=>p(e)).filter(Boolean).slice(0,2):[];return 2!==t.length?null:{trailIds:t,classification:f(e.classification),confidence:u(e.confidence),overlap:p(e.overlap),distinction:p(e.distinction),recommendation:p(e.recommendation)}}).filter(Boolean):[])}})}catch(e){return console.error("Memex trail overlap review failed",e),s.NextResponse.json({error:e instanceof Error?e.message:"Unknown Memex trail overlap review error"},{status:500})}}let v=new n.AppRouteRouteModule({definition:{kind:i.x.APP_ROUTE,page:"/memex-trail-overlap/route",pathname:"/memex-trail-overlap",filename:"route",bundlePath:"app/memex-trail-overlap/route"},resolvedPagePath:"/home/hp/hedgedoc-build-overlap/frontend/src/app/memex-trail-overlap/route.ts",nextConfigOutput:"standalone",userland:a}),{requestAsyncStorage:y,staticGenerationAsyncStorage:g,serverHooks:w}=v,b="/memex-trail-overlap/route";function x(){return(0,o.patchFetch)({serverHooks:w,staticGenerationAsyncStorage:g})}}};var t=require("../../webpack-runtime.js");t.C(e);var r=e=>t(t.s=e),a=t.X(0,[9561,13472],()=>r(78446));module.exports=a})();