"use strict";(()=>{var e={};e.id=86151,e.ids=[86151],e.modules={20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},6005:e=>{e.exports=require("node:crypto")},93977:e=>{e.exports=require("node:fs/promises")},25135:(e,t,n)=>{n.r(t),n.d(t,{originalPathname:()=>T,patchFetch:()=>M,requestAsyncStorage:()=>O,routeModule:()=>w,serverHooks:()=>E,staticGenerationAsyncStorage:()=>y});var r={};n.r(r),n.d(r,{POST:()=>x,dynamic:()=>m,runtime:()=>c});var i=n(93277),s=n(15265),a=n(55356),o=n(6005),l=n(93977),u=n(67076);let c="nodejs",m="force-dynamic",p="/data/projects/hedgedoc",d=`${p}/memex/index.md`,h=`${p}/memex/user_trails.jsonl`;async function f(e){let[t,n]=await Promise.all([(0,l.readFile)(d,"utf8"),(0,l.readFile)(`${p}/.env.memex`,"utf8")]),{trailSection:r}=function(e){let t;let n=e.split("## Sources",2)[1]?.split("## Trails",1)[0]??"",r=e.split("## Trails",2)[1]??"",i=[],s=/^- \[([^\]]+)\]\([^)]*\/n\/([^?#)]+)[^)]*\)(?: — (.*))?$/gm;for(;null!==(t=s.exec(n));)i.push({id:i.length+1,title:t[1],alias:decodeURIComponent(t[2]),summary:t[3]??""});return{sources:i,trailSection:r}}(t),i=function(e){let t={};for(let n of e.split("\n")){let e=n.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);e&&(t[e[1]]=e[2].trim().replace(/^['"]|['"]$/g,""))}return t}(n),s=i.MEMEX_OLLAMA_URL||i.OLLAMA_URL||i.OLLAMA_HOST||"http://192.168.1.99:11434",a=i.MEMEX_OLLAMA_MODEL||i.OLLAMA_MODEL||"gemma4:26b",o=function(e){let t=[...e.matchAll(/^###\s+(.+)$/gm)];return 0===t.length?"(none)":t.map((n,r)=>{let i=(n.index??0)+n[0].length,s=t[r+1]?.index??e.length,a=e.slice(i,s).split("\n").map(e=>e.trim()).find(e=>e&&!e.startsWith("-")&&!e.includes("/n/"))??"";return a?`- ${n[1].trim()} — ${a}`:`- ${n[1].trim()}`}).join("\n")}(r),u=`
You are helping a user create a personal Memex trail.

USER EXPRESSION:
${e}

EXISTING TRAILS:
${o}

IMPORTANT:
You are NOT being given the user's existing documents or source pages.
Do NOT invent, infer, select, or mention source documents.
Do NOT force the user's idea into known places, records, buildings, or pages.

First understand the user's intended experience.

Consider:
1. ACTION — what the user wants to do.
2. SUBJECT — what they are interested in.
3. CONTEXT — where/how the experience happens.
4. OUTCOME — what they want from it.
5. PERSONAL EXPERIENCE — memories, places visited, things encountered,
   journeys taken, or places they want to revisit.

Language such as:
- "a place I have been"
- "somewhere I've visited"
- "a place I remember"
- "where I went before"

means PERSONAL PAST EXPERIENCE.

It does NOT mean archaeology, a vanished place, hypothetical history,
or "where something would have been".

EXISTING TRAIL MATCH

An existing trail is a match only when its purpose and activity strongly
match the user's expression.

Topic similarity alone is not enough.

If there is a strong existing match, return:

{
  "existingMatch": {
    "name": "exact existing trail name",
    "reason": "brief explanation",
    "confidence": 0.0
  },
  "options": []
}

Only use existingMatch when confidence is at least 0.85.

Otherwise return EXACTLY TWO different personal trail concepts:

{
  "existingMatch": null,
  "options": [
    {
      "name": "short trail name",
      "reason": "brief interpretation of the user's intent"
    },
    {
      "name": "different short trail name",
      "reason": "brief alternative interpretation"
    }
  ]
}

Rules:
- Preserve the user's activity and personal intent.
- Do not mention or select existing source documents.
- Do not invent places the user did not name.
- Do not assume where the user has been.
- Option 1 should be the closest interpretation.
- Option 2 should be meaningfully different but still plausible.
- Prefer experience-oriented trail names.
- Keep reasons brief.
- Return JSON only.
`.trim(),c=await fetch(`${s.replace(/\/$/,"")}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:a,stream:!1,format:"json",messages:[{role:"user",content:u}]})});if(!c.ok)throw Error(`Ollama HTTP ${c.status}`);let m=await c.json(),h=JSON.parse(m.message?.content??"{}");if(h.existingMatch?.name&&(h.existingMatch.confidence??0)>=.85&&r.toLowerCase().includes(h.existingMatch.name.toLowerCase()))return{existingMatch:{name:h.existingMatch.name,reason:h.existingMatch.reason??"",confidence:h.existingMatch.confidence},options:[]};let f=(h.options??[]).slice(0,2).map(e=>({name:e.name?.trim()??"",reason:e.reason?.trim()??"",members:[]})).filter(e=>e.name);if(2!==f.length)throw Error("LLM did not return two valid trail options");return{existingMatch:null,options:f}}async function g(e,t){if(!t.name.trim())throw Error("Invalid user trail");let n={id:(0,o.randomUUID)(),type:"user-trail",origin:"user",status:"draft",nodeBookStatus:"draft",createdAt:new Date().toISOString(),expression:e,name:t.name.trim(),reason:t.reason.trim(),members:[]};return await (0,l.appendFile)(h,`${JSON.stringify(n)}
`,"utf8"),n}async function x(e){try{let t=await e.json(),n=t.expression?.trim()??"";if(!n)return u.NextResponse.json({error:"Trail expression is required"},{status:400});if("analyze"===t.action)return u.NextResponse.json(await f(n));if("commit"===t.action&&t.option)return u.NextResponse.json({committed:await g(n,t.option)});return u.NextResponse.json({error:"Invalid action"},{status:400})}catch(e){return u.NextResponse.json({error:e instanceof Error?e.message:"Unknown error"},{status:500})}}let w=new i.AppRouteRouteModule({definition:{kind:s.x.APP_ROUTE,page:"/memex-user-trails/route",pathname:"/memex-user-trails",filename:"route",bundlePath:"app/memex-user-trails/route"},resolvedPagePath:"/data/projects/hedgedoc/frontend/src/app/memex-user-trails/route.ts",nextConfigOutput:"standalone",userland:r}),{requestAsyncStorage:O,staticGenerationAsyncStorage:y,serverHooks:E}=w,T="/memex-user-trails/route";function M(){return(0,a.patchFetch)({serverHooks:E,staticGenerationAsyncStorage:y})}}};var t=require("../../webpack-runtime.js");t.C(e);var n=e=>t(t.s=e),r=t.X(0,[90916,73786],()=>n(25135));module.exports=r})();