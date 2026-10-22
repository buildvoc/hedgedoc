exports.id=58968,exports.ids=[58968],exports.modules={14663:e=>{function t(e){var t=Error("Cannot find module '"+e+"'");throw t.code="MODULE_NOT_FOUND",t}t.keys=()=>[],t.resolve=t,t.id=14663,e.exports=t},65678:(e,t,a)=>{"use strict";function i(e,t){e.accDescr&&t.setAccDescription?.(e.accDescr),e.accTitle&&t.setAccTitle?.(e.accTitle),e.title&&t.setDiagramTitle?.(e.title)}a.d(t,{A:()=>i}),(0,a(85920).eW)(i,"populateCommonDb")},54123:(e,t,a)=>{"use strict";a.d(t,{diagram:()=>W});var i=a(7472),l=a(65678),r=a(42402),s=a(1353),o=a(85920),n=a(98110),c=a(26077),p=s.vZ.pie,d={sections:new Map,showData:!1,config:p},u=d.sections,g=d.showData,f=structuredClone(p),h=(0,o.eW)(()=>structuredClone(f),"getConfig"),x=(0,o.eW)(()=>{u=new Map,g=d.showData,(0,s.ZH)()},"clear"),m=(0,o.eW)(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);u.has(e)||(u.set(e,t),o.cM.debug(`added new section: ${e}, with value: ${t}`))},"addSection"),w=(0,o.eW)(()=>u,"getSections"),v=(0,o.eW)(e=>{g=e},"setShowData"),T=(0,o.eW)(()=>g,"getShowData"),$={getConfig:h,clear:x,setDiagramTitle:s.g2,getDiagramTitle:s.Kr,setAccTitle:s.GN,getAccTitle:s.eu,setAccDescription:s.U$,getAccDescription:s.Mx,addSection:m,getSections:w,setShowData:v,getShowData:T},D=(0,o.eW)((e,t)=>{(0,l.A)(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},"populateDb"),S={parse:(0,o.eW)(async e=>{let t=await (0,n.Qc)("pie",e);o.cM.debug(t),D(t,$)},"parse")},y=(0,o.eW)(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,"getStyles"),C=(0,o.eW)(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),a=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1).sort((e,t)=>t.value-e.value);return(0,c.ve8)().value(e=>e.value)(a)},"createPieArcs"),W={parser:S,db:$,renderer:{draw:(0,o.eW)((e,t,a,l)=>{o.cM.debug("rendering pie chart\n"+e);let n=l.db,p=(0,s.nV)(),d=(0,r.Rb)(n.getConfig(),p.pie),u=(0,i.P)(t),g=u.append("g");g.attr("transform","translate(225,225)");let{themeVariables:f}=p,[h]=(0,r.VG)(f.pieOuterStrokeWidth);h??=2;let x=d.textPosition,m=(0,c.Nb1)().innerRadius(0).outerRadius(185),w=(0,c.Nb1)().innerRadius(185*x).outerRadius(185*x);g.append("circle").attr("cx",0).attr("cy",0).attr("r",185+h/2).attr("class","pieOuterCircle");let v=n.getSections(),T=C(v),$=[f.pie1,f.pie2,f.pie3,f.pie4,f.pie5,f.pie6,f.pie7,f.pie8,f.pie9,f.pie10,f.pie11,f.pie12],D=0;v.forEach(e=>{D+=e});let S=T.filter(e=>"0"!==(e.data.value/D*100).toFixed(0)),y=(0,c.PKp)($);g.selectAll("mySlices").data(S).enter().append("path").attr("d",m).attr("fill",e=>y(e.data.label)).attr("class","pieCircle"),g.selectAll("mySlices").data(S).enter().append("text").text(e=>(e.data.value/D*100).toFixed(0)+"%").attr("transform",e=>"translate("+w.centroid(e)+")").style("text-anchor","middle").attr("class","slice"),g.append("text").text(n.getDiagramTitle()).attr("x",0).attr("y",-200).attr("class","pieTitleText");let W=[...v.entries()].map(([e,t])=>({label:e,value:t})),b=g.selectAll(".legend").data(W).enter().append("g").attr("class","legend").attr("transform",(e,t)=>"translate(216,"+(22*t-22*W.length/2)+")");b.append("rect").attr("width",18).attr("height",18).style("fill",e=>y(e.label)).style("stroke",e=>y(e.label)),b.append("text").attr("x",22).attr("y",14).text(e=>n.getShowData()?`${e.label} [${e.value}]`:e.label);let A=512+Math.max(...b.selectAll("text").nodes().map(e=>e?.getBoundingClientRect().width??0));u.attr("viewBox",`0 0 ${A} 450`),(0,s.v2)(u,450,A,d.useMaxWidth)},"draw")},styles:y}}};